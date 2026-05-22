#!/usr/bin/env bash
set -euo pipefail

# Demo smoke-test for Aurora Stays deployment
# Usage: ./demo_smoke.sh

FRONTEND_URL="https://frontend.mangowater-b28dd996.swedencentral.azurecontainerapps.io"
API_GATEWAY="https://api-gateway.mangowater-b28dd996.swedencentral.azurecontainerapps.io"

echo "Checking deployed frontend assets..."

echo "- styles.css contains chat hide rule:"
if curl -sSL "$FRONTEND_URL/styles.css" | grep -q ".chat-panel[hidden]"; then
  echo "  OK: .chat-panel[hidden] present"
else
  echo "  MISSING: .chat-panel[hidden] not found"
fi

echo "- app.js contains attribute-based logic and debug log:"
if curl -sSL "$FRONTEND_URL/app.js" | grep -q "setAttribute('hidden'"; then
  echo "  OK: setAttribute('hidden') present"
else
  echo "  MISSING: setAttribute('hidden') not found"
fi
if curl -sSL "$FRONTEND_URL/app.js" | grep -q "chat toggle clicked"; then
  echo "  OK: debug log 'chat toggle clicked' present"
else
  echo "  MISSING: debug log not found"
fi

echo "\nTesting API endpoints via API gateway..."

echo "- Search endpoint (sample):"
curl -sS "$API_GATEWAY/v1/search?destination=Bodrum&start=2026-06-01&end=2026-06-04&guests=2&page=1&pageSize=3" | jq . || true

echo "- Hotel detail (hotel-swiss):"
curl -sS "$API_GATEWAY/v1/hotels/hotel-swiss" | jq . || true

echo "\nQuick manual step: open the frontend in your browser to interactively verify chat toggle and hotel detail UI:"
echo "  open $FRONTEND_URL"

echo "Demo script finished."
