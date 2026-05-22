# Azure deployment

`azure-deploy.sh` provisions and deploys the **whole system** to Azure with one
command. No local Docker is needed — the container images are built in the
cloud with `az acr build`.

## What gets created

| Resource | Azure service | Purpose |
| --- | --- | --- |
| `cosmos-<suffix>` | Azure Cosmos DB (Mongo API) | Database (SQLite is not allowed by the spec) |
| `redis-<suffix>` | Azure Cache for Redis (Basic C0) | Distributed cache for hotel details |
| `rabbitmq` | Azure Container Instance | Reservation queue |
| `acr<suffix>` | Azure Container Registry | Holds the built images |
| `cae-<suffix>` | Azure Container Apps environment | Runs the services |
| 5 backend apps | Azure Container Apps (internal ingress) | iam, hotel, comments, notification, ai-agent |
| `api-gateway` | Azure Container App (public) | Single public API entry point |
| `frontend` | Azure Container App (public) | The web UI |

## Prerequisites

1. `az login` completed.
2. The Entra app registration already exists (the IDs are in the script's CONFIG block).
3. An Azure subscription with quota — *Azure for Students* is enough.
4. (Recommended) A free Groq API key from <https://console.groq.com> for the AI
   agent. Put it in the `LLM_API_KEY` field of the script's CONFIG block. If left
   empty the agent deploys with its rule-based fallback instead.

## Run it

```bash
# 1. (once) make the SUFFIX globally unique — edit the CONFIG block
nano deploy/azure-deploy.sh         # change SUFFIX if you hit a name clash

# 2. run
chmod +x deploy/azure-deploy.sh
./deploy/azure-deploy.sh
```

Expect **~30-45 minutes**, most of it waiting for Cosmos DB and Redis to
provision (they run in the background while the images build). The script is
**safe to re-run** — existing resources are reused and only updated.

## After it finishes

* The deployed URLs are printed and saved to `deploy/DEPLOYED.txt`.
* Paste the Frontend + API Gateway URLs into `README.md` section 1.
* The script already adds the deployed frontend URL to the Entra app's SPA
  redirect URIs, so Microsoft login works on the live site immediately.

## Tearing it down (stop billing)

```bash
az group delete --name se4458-final --yes --no-wait
```

## Troubleshooting

* **Name already taken** (Cosmos / ACR / Redis are globally unique) — change
  `SUFFIX` in the CONFIG block and re-run.
* **A service shows errors** — check logs:
  ```bash
  az containerapp logs show --name hotel-service --resource-group se4458-final --follow
  ```
* **Login popup fails on the live site** — confirm the frontend URL is in the
  Entra app's SPA redirect URIs (Azure Portal → App registrations → your app →
  Authentication), or re-run the script (step 11 re-applies them).
