#!/usr/bin/env bash
set -euo pipefail

RG="${RG:-HunterLabSoftware}"
APP="${APP:-hunterlab-update-server}"

echo "Resource group: $RG"
echo "Web app: $APP"

# Ensure az is available
command -v az >/dev/null 2>&1 || { echo "Error: Azure CLI (az) is required"; exit 1; }

# Stage minimal payload
STAGE_DIR=$(mktemp -d -t hlstage-XXXXXXXX)
cp -f update_server.js "$STAGE_DIR/"
cp -f package.json "$STAGE_DIR/"
cp -f package-lock.json "$STAGE_DIR/" 2>/dev/null || true
[ -f Procfile ] && cp -f Procfile "$STAGE_DIR/" || true

ZIP_FILE=$(mktemp -t hlupdate-XXXXXXXX).zip
( cd "$STAGE_DIR" && zip -r "$ZIP_FILE" . >/dev/null )

# Deploy
if az webapp deploy --help >/dev/null 2>&1; then
  az webapp deploy -g "$RG" -n "$APP" --src-path "$ZIP_FILE" --type zip --clean true
else
  az webapp deployment source config-zip -g "$RG" -n "$APP" --src "$ZIP_FILE"
fi

# Restart app
az webapp restart -g "$RG" -n "$APP"

HOST=$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)
echo "Deployed. Health: https://$HOST/health"


