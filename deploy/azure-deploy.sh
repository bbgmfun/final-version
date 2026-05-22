#!/usr/bin/env bash
###############################################################################
# Hotel Booking System — one-shot Azure deployment
# SE 4458 Final — Group 1
#
# What this does (no local Docker required — images are built in the cloud):
#   1. Resource group
#   2. Azure Cosmos DB (MongoDB API)        -> MONGO_URI
#   3. Azure Cache for Redis                -> REDIS_URL   (distributed cache)
#   4. RabbitMQ on an Azure Container Instance -> RABBITMQ_URL
#   5. Azure Container Registry + cloud image builds
#   6. Azure Container Apps environment
#   7. 5 backend services (internal ingress) + API gateway + frontend (public)
#   8. Updates the Entra app registration with the deployed redirect URIs
#
# PREREQUISITES
#   - az CLI installed and `az login` done
#   - the Entra app registration already exists (see README section 5)
#
# USAGE
#   1. Edit the CONFIG block below (at minimum make SUFFIX globally unique).
#   2. chmod +x deploy/azure-deploy.sh
#   3. ./deploy/azure-deploy.sh
#
# The script is safe to re-run; existing resources are reused.
# Total time: ~30-45 min (mostly Cosmos/Redis provisioning, which run in
# the background while images build).
###############################################################################
set -euo pipefail

# ----------------------------- CONFIG ---------------------------------------
# SUFFIX must be globally unique (used in Cosmos/ACR/Redis/ACI names).
# Change the random part if a name collision occurs.
SUFFIX="se4458bb1"
# Azure for Students subscriptions restrict regions. If you get
# "RequestDisallowedByAzure", re-run with another region, e.g.:
#     LOCATION=westus3 LLM_API_KEY="<groq-key>" ./deploy/azure-deploy.sh
LOCATION="${LOCATION:-eastus2}"
RG="se4458-final"

# Entra ID app registration (from `az ad app create`)
TENANT_ID="e7c46463-2529-40d9-b0e5-4b8a4acd39dd"
CLIENT_ID="9549924f-8527-4327-8761-57cfde23985b"
ADMIN_EMAILS="22070006074@stu.yasar.edu.tr"
ADMIN_HOTEL_IDS="hotel-swiss"

# AI Agent LLM — get a FREE key at https://console.groq.com
# The key is read from the environment so it is NEVER written into this file
# (which is committed to git). Run the script like this:
#     LLM_API_KEY="<groq-key>" ./deploy/azure-deploy.sh
# If unset, the agent deploys with its rule-based fallback instead.
LLM_BASE_URL="https://api.groq.com/openai/v1"
LLM_API_KEY="${LLM_API_KEY:-}"
LLM_MODEL="llama-3.3-70b-versatile"

# Derived names
ACR="acr${SUFFIX}"
COSMOS="cosmos-${SUFFIX}"
REDIS="redis-${SUFFIX}"
RABBIT_DNS="rabbitmq-${SUFFIX}"
CAENV="cae-${SUFFIX}"
QUEUE_NAME="reservations"
# Unique per-run stamp — forces a fresh Container App revision on every deploy
# so re-runs always pick up the newly built :latest image.
STAMP="r$(date +%H%M%S)"

# Repo root = parent of this script's directory
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { echo -e "\n\033[1;36m==> $*\033[0m"; }

# ----------------------------- 0. PREP --------------------------------------
say "Checking az CLI + extensions"
az account show >/dev/null || { echo "Run 'az login' first."; exit 1; }
az extension add --name containerapp --upgrade --only-show-errors

say "Registering Azure resource providers (one-time, may take a few minutes)"
PROVIDERS="Microsoft.DocumentDB Microsoft.Cache Microsoft.ContainerRegistry Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerInstance Microsoft.Network"
# Kick off all registrations (they run in parallel in the Azure backend)
for ns in $PROVIDERS; do
  az provider register --namespace "$ns" --only-show-errors >/dev/null 2>&1 || true
done
# Wait until each one reports Registered
for ns in $PROVIDERS; do
  while [ "$(az provider show --namespace "$ns" --query registrationState -o tsv 2>/dev/null)" != "Registered" ]; do
    echo "  ...waiting for $ns"
    sleep 15
  done
  echo "  $ns ready"
done

# ----------------------------- 1. RESOURCE GROUP ----------------------------
say "Resource group: $RG"
# Reuse the group if it already exists (its location is just metadata —
# the actual resources are created in $LOCATION regardless).
if ! az group show --name "$RG" >/dev/null 2>&1; then
  az group create --name "$RG" --location "$LOCATION" --only-show-errors >/dev/null
fi

# ----------------------------- 2. COSMOS DB --------------------------------
say "Cosmos DB (Mongo API): $COSMOS  [~5-10 min, please wait]"
if ! az cosmosdb show --name "$COSMOS" --resource-group "$RG" >/dev/null 2>&1; then
  az cosmosdb create --name "$COSMOS" --resource-group "$RG" \
    --kind MongoDB --server-version 4.2 \
    --default-consistency-level Eventual \
    --locations regionName="$LOCATION" failoverPriority=0 isZoneRedundant=False
fi

# ----------------------------- 3. REDIS ------------------------------------
say "Azure Cache for Redis: $REDIS  [~15-20 min, please wait]"
if ! az redis show --name "$REDIS" --resource-group "$RG" >/dev/null 2>&1; then
  az redis create --name "$REDIS" --resource-group "$RG" \
    --location "$LOCATION" --sku Basic --vm-size c0
fi

# ----------------------------- 4. RABBITMQ (ACI) ----------------------------
say "RabbitMQ on Azure Container Instance"
if ! az container show --name rabbitmq --resource-group "$RG" >/dev/null 2>&1; then
  az container create --name rabbitmq --resource-group "$RG" \
    --location "$LOCATION" \
    --image rabbitmq:3-management --os-type Linux \
    --cpu 1 --memory 1.5 \
    --ports 5672 15672 \
    --dns-name-label "$RABBIT_DNS" \
    --only-show-errors >/dev/null
fi
RABBIT_FQDN="$(az container show --name rabbitmq --resource-group "$RG" \
  --query ipAddress.fqdn -o tsv)"
RABBITMQ_URL="amqp://${RABBIT_FQDN}:5672"
echo "RABBITMQ_URL = $RABBITMQ_URL"

# ----------------------------- 5. ACR + IMAGE BUILDS ------------------------
say "Azure Container Registry: $ACR"
if ! az acr show --name "$ACR" >/dev/null 2>&1; then
  az acr create --name "$ACR" --resource-group "$RG" --sku Basic \
    --location "$LOCATION" --admin-enabled true --only-show-errors >/dev/null
fi
ACR_SERVER="$(az acr show --name "$ACR" --query loginServer -o tsv)"
ACR_USER="$(az acr credential show --name "$ACR" --query username -o tsv)"
ACR_PASS="$(az acr credential show --name "$ACR" --query 'passwords[0].value' -o tsv)"

build_image() {  # build_image <name> <context-path>
  say "Building image: $1"
  az acr build --registry "$ACR" --image "$1:latest" "$2" --only-show-errors
}
build_image iam-service          "$ROOT/services/iam-service"
build_image hotel-service        "$ROOT/services/hotel-service"
build_image comments-service     "$ROOT/services/comments-service"
build_image notification-service "$ROOT/services/notification-service"
build_image ai-agent-service     "$ROOT/services/ai-agent-service"
build_image api-gateway          "$ROOT/api-gateway"
# frontend image is built later (after we know the gateway URL)

# ----------------------------- 6. CONTAINER APPS ENVIRONMENT ----------------
say "Container Apps environment"
# Azure for Students allows only 1 Container Apps environment per region —
# reuse any existing one, otherwise create ours.
CAENV_ID="$(az containerapp env list --query "[0].id" -o tsv 2>/dev/null || true)"
if [ -z "$CAENV_ID" ]; then
  az containerapp env create --name "$CAENV" --resource-group "$RG" \
    --location "$LOCATION" --only-show-errors >/dev/null
  CAENV_ID="$(az containerapp env show --name "$CAENV" --resource-group "$RG" --query id -o tsv)"
fi
echo "Using environment: $CAENV_ID"

# ----------------------------- 7. CONNECTION STRINGS ------------------------
say "Reading Cosmos DB connection string"
# Raw Cosmos connection string — passed as-is. The services select the
# `hotelbooking` database via the Mongoose `dbName` option, so we must NOT
# rewrite the URI here (string surgery on it is fragile and error-prone).
MONGO_URI="$(az cosmosdb keys list --name "$COSMOS" --resource-group "$RG" \
  --type connection-strings \
  --query "connectionStrings[0].connectionString" -o tsv)"
if [ -z "$MONGO_URI" ] || [ "${MONGO_URI#mongodb}" = "$MONGO_URI" ]; then
  echo "FATAL: invalid Mongo connection string read from Cosmos -> '${MONGO_URI:0:30}'"
  exit 1
fi
echo "MONGO_URI acquired (starts with: ${MONGO_URI:0:14}...)."

say "Reading Redis connection details"
# Make sure Redis really finished (it is the slowest resource)
while [ "$(az redis show --name "$REDIS" --resource-group "$RG" --query provisioningState -o tsv)" != "Succeeded" ]; do
  echo "  ...still provisioning Redis ($(date +%H:%M:%S))"; sleep 30
done
REDIS_HOST="$(az redis show --name "$REDIS" --resource-group "$RG" --query hostName -o tsv)"
REDIS_KEY="$(az redis list-keys --name "$REDIS" --resource-group "$RG" --query primaryKey -o tsv)"
REDIS_URL="rediss://:${REDIS_KEY}@${REDIS_HOST}:6380"
echo "REDIS_URL acquired."

# ----------------------------- 8. BACKEND SERVICES (internal) ---------------
# deploy_backend <name> <port>
deploy_backend() {
  local name="$1" port="$2"
  say "Deploying $name (internal)"
  # Env vars are identical for create and update — define once.
  local ENVV=(
    "PORT=$port"
    "MONGO_URI=secretref:mongo-uri"
    "REDIS_URL=secretref:redis-url"
    "RABBITMQ_URL=$RABBITMQ_URL"
    "RESERVATION_QUEUE=$QUEUE_NAME"
    "ENTRA_TENANT_ID=$TENANT_ID"
    "ENTRA_CLIENT_ID=$CLIENT_ID"
    "ADMIN_EMAILS=$ADMIN_EMAILS"
    "ADMIN_HOTEL_IDS=$ADMIN_HOTEL_IDS"
    "LOGIN_DISCOUNT=0.15"
    "CAPACITY_ALERT_THRESHOLD=0.20"
  )
  if az containerapp show --name "$name" --resource-group "$RG" >/dev/null 2>&1; then
    # IMPORTANT: refresh the secrets too — an `update` that only changes the
    # image keeps stale secret values from the first deploy.
    az containerapp secret set --name "$name" --resource-group "$RG" \
      --secrets mongo-uri="$MONGO_URI" redis-url="$REDIS_URL" --only-show-errors >/dev/null
    az containerapp update --name "$name" --resource-group "$RG" \
      --image "$ACR_SERVER/$name:latest" --revision-suffix "$STAMP" \
      --set-env-vars "${ENVV[@]}" --only-show-errors >/dev/null
  else
    az containerapp create --name "$name" --resource-group "$RG" \
      --environment "$CAENV_ID" \
      --image "$ACR_SERVER/$name:latest" \
      --registry-server "$ACR_SERVER" \
      --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
      --ingress internal --target-port "$port" \
      --min-replicas 1 --cpu 0.5 --memory 1.0Gi \
      --secrets mongo-uri="$MONGO_URI" redis-url="$REDIS_URL" \
      --env-vars "${ENVV[@]}" \
      --only-show-errors >/dev/null
  fi
}

deploy_backend iam-service          4001
deploy_backend hotel-service        4002
deploy_backend comments-service     4003
deploy_backend notification-service 4004

# Capture internal FQDNs
fqdn() { az containerapp show --name "$1" --resource-group "$RG" \
  --query properties.configuration.ingress.fqdn -o tsv; }
IAM_FQDN="$(fqdn iam-service)"
HOTEL_FQDN="$(fqdn hotel-service)"
COMMENTS_FQDN="$(fqdn comments-service)"
NOTIF_FQDN="$(fqdn notification-service)"

# ai-agent needs HOTEL_URL + the LLM config
say "Deploying ai-agent-service (internal)"
if az containerapp show --name ai-agent-service --resource-group "$RG" >/dev/null 2>&1; then
  az containerapp update --name ai-agent-service --resource-group "$RG" \
    --image "$ACR_SERVER/ai-agent-service:latest" --revision-suffix "$STAMP" \
    --set-env-vars HOTEL_URL="https://$HOTEL_FQDN" \
      LLM_BASE_URL="$LLM_BASE_URL" LLM_MODEL="$LLM_MODEL" --only-show-errors >/dev/null
  if [ -n "$LLM_API_KEY" ]; then
    az containerapp secret set --name ai-agent-service --resource-group "$RG" \
      --secrets llm-api-key="$LLM_API_KEY" --only-show-errors >/dev/null
    az containerapp update --name ai-agent-service --resource-group "$RG" \
      --set-env-vars LLM_API_KEY=secretref:llm-api-key --only-show-errors >/dev/null
  fi
else
  AI_SECRETS=()
  AI_ENV=(PORT=4005 HOTEL_URL="https://$HOTEL_FQDN" LLM_BASE_URL="$LLM_BASE_URL" LLM_MODEL="$LLM_MODEL")
  if [ -n "$LLM_API_KEY" ]; then
    AI_SECRETS=(--secrets llm-api-key="$LLM_API_KEY")
    AI_ENV+=(LLM_API_KEY=secretref:llm-api-key)
  fi
  az containerapp create --name ai-agent-service --resource-group "$RG" \
    --environment "$CAENV_ID" \
    --image "$ACR_SERVER/ai-agent-service:latest" \
    --registry-server "$ACR_SERVER" \
    --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
    --ingress internal --target-port 4005 \
    --min-replicas 1 --cpu 0.5 --memory 1.0Gi \
    "${AI_SECRETS[@]}" \
    --env-vars "${AI_ENV[@]}" \
    --only-show-errors >/dev/null
fi
AI_FQDN="$(fqdn ai-agent-service)"

# ----------------------------- 9. API GATEWAY (public) ----------------------
say "Deploying api-gateway (public)"
if az containerapp show --name api-gateway --resource-group "$RG" >/dev/null 2>&1; then
  az containerapp update --name api-gateway --resource-group "$RG" \
    --image "$ACR_SERVER/api-gateway:latest" --revision-suffix "$STAMP" \
    --set-env-vars \
      IAM_URL="https://$IAM_FQDN" HOTEL_URL="https://$HOTEL_FQDN" \
      COMMENTS_URL="https://$COMMENTS_FQDN" NOTIFICATION_URL="https://$NOTIF_FQDN" \
      AI_AGENT_URL="https://$AI_FQDN" --only-show-errors >/dev/null
else
  az containerapp create --name api-gateway --resource-group "$RG" \
    --environment "$CAENV_ID" \
    --image "$ACR_SERVER/api-gateway:latest" \
    --registry-server "$ACR_SERVER" \
    --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
    --ingress external --target-port 8080 \
    --min-replicas 1 --cpu 0.5 --memory 1.0Gi \
    --env-vars \
      PORT=8080 \
      IAM_URL="https://$IAM_FQDN" \
      HOTEL_URL="https://$HOTEL_FQDN" \
      COMMENTS_URL="https://$COMMENTS_FQDN" \
      NOTIFICATION_URL="https://$NOTIF_FQDN" \
      AI_AGENT_URL="https://$AI_FQDN" \
    --only-show-errors >/dev/null
fi
GATEWAY_URL="https://$(fqdn api-gateway)"
echo "GATEWAY_URL = $GATEWAY_URL"

# ----------------------------- 10. FRONTEND (public) ------------------------
# Inject the gateway URL into index.html before building the static image.
say "Building + deploying frontend with api-base=$GATEWAY_URL"
FRONT_INDEX="$ROOT/frontend/src/index.html"
cp "$FRONT_INDEX" "$FRONT_INDEX.bak"
# Set the api-base meta tag content
sed -i.tmp "s#<meta name=\"api-base\" content=\"[^\"]*\" />#<meta name=\"api-base\" content=\"$GATEWAY_URL\" />#" "$FRONT_INDEX"
rm -f "$FRONT_INDEX.tmp"

az acr build --registry "$ACR" --image "frontend:latest" "$ROOT/frontend" --only-show-errors

# restore the original index.html (so the repo stays clean for local dev)
mv "$FRONT_INDEX.bak" "$FRONT_INDEX"

if az containerapp show --name frontend --resource-group "$RG" >/dev/null 2>&1; then
  az containerapp update --name frontend --resource-group "$RG" \
    --image "$ACR_SERVER/frontend:latest" --revision-suffix "$STAMP" --only-show-errors >/dev/null
else
  az containerapp create --name frontend --resource-group "$RG" \
    --environment "$CAENV_ID" \
    --image "$ACR_SERVER/frontend:latest" \
    --registry-server "$ACR_SERVER" \
    --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
    --ingress external --target-port 80 \
    --min-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --only-show-errors >/dev/null
fi
FRONTEND_URL="https://$(fqdn frontend)"
echo "FRONTEND_URL = $FRONTEND_URL"

# ----------------------------- 11. ENTRA REDIRECT URIs ----------------------
say "Updating Entra app SPA redirect URIs"
OBJECT_ID="$(az ad app show --id "$CLIENT_ID" --query id -o tsv)"
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/$OBJECT_ID" \
  --headers "Content-Type=application/json" \
  --body "{\"spa\":{\"redirectUris\":[\"http://localhost:5173\",\"http://localhost:8080\",\"$FRONTEND_URL\"]}}"

# ----------------------------- 12. SUMMARY ----------------------------------
SUMMARY="$ROOT/deploy/DEPLOYED.txt"
{
  echo "Hotel Booking System — deployed $(date)"
  echo "---------------------------------------------"
  echo "Frontend (UI)   : $FRONTEND_URL"
  echo "API Gateway     : $GATEWAY_URL/v1/health"
  echo "RabbitMQ console: http://${RABBIT_FQDN}:15672  (guest/guest)"
  echo ""
  echo "Paste these into README.md section 1."
} | tee "$SUMMARY"

say "DONE. Open $FRONTEND_URL and sign in with Microsoft."
