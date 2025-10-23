#!/usr/bin/env bash
set -euo pipefail

RG="HunterLabSoftware"
SA_NAME="hunterlabstorage"
PLAN_NAME="hunterlab-plan"
WEBAPP_NAME="hunterlab-update-server"

echo "Using resource group: $RG"

# Force deployment region to East US regardless of RG metadata location
LOCATION="eastus"
echo "Using region: $LOCATION"

# Optional: delete an existing App Service plan (and its apps) before creating the new one
# Usage: set DELETE_PLAN_NAME to the plan you want to remove, e.g. DELETE_PLAN_NAME=test-linux-free ./azure_setup.bash
if [ -n "${DELETE_PLAN_NAME:-}" ]; then
  echo "Deleting existing plan: $DELETE_PLAN_NAME (and any apps using it)"
  APPS_ON_PLAN="$(az webapp list -g "$RG" --query "[?serverFarmId!=null && contains(serverFarmId, '/serverfarms/${DELETE_PLAN_NAME}')].name" -o tsv 2>/dev/null || true)"
  if [ -n "$APPS_ON_PLAN" ]; then
    for APP in $APPS_ON_PLAN; do
      echo " - Deleting web app: $APP"
      az webapp delete -g "$RG" -n "$APP" >/dev/null || true
    done
  fi
  az appservice plan delete -g "$RG" -n "$DELETE_PLAN_NAME" --yes >/dev/null || true
fi

# Storage name availability (global)
if ! az storage account show -g "$RG" -n "$SA_NAME" >/dev/null 2>&1; then
  AVAILABLE="$(az storage account check-name --name "$SA_NAME" --query nameAvailable -o tsv)"
  if [ "$AVAILABLE" != "true" ]; then
    echo "ERROR: Storage account name '$SA_NAME' is not available. Choose a different SA_NAME and rerun."
    exit 1
  fi
  echo "Creating storage account: $SA_NAME"
  az storage account create -g "$RG" -n "$SA_NAME" -l "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 --https-only true \
    --allow-blob-public-access false >/dev/null
fi

echo "Ensuring blob container 'updates'"
az storage container create --name updates --account-name "$SA_NAME" --auth-mode login --public-access off >/dev/null
CONN_STRING="$(az storage account show-connection-string -g "$RG" -n "$SA_NAME" --query connectionString -o tsv)"

# App Service plan (Linux)
if ! az appservice plan show -g "$RG" -n "$PLAN_NAME" >/dev/null 2>&1; then
  echo "Creating plan: $PLAN_NAME"
  # Use Linux Free (F1) to avoid Basic tier quota limits; you can change to B1/S1 later
  az appservice plan create -g "$RG" -n "$PLAN_NAME" --is-linux --sku F1 --location "$LOCATION" >/dev/null
fi

# Web App (Node 22 LTS)
if ! az webapp show -g "$RG" -n "$WEBAPP_NAME" >/dev/null 2>&1; then
  echo "Creating web app: $WEBAPP_NAME"
  # Linux runtime identifiers use COLON (e.g., NODE:22-lts)
  az webapp create -g "$RG" -p "$PLAN_NAME" -n "$WEBAPP_NAME" --runtime "NODE:22-lts" >/dev/null
fi

# App settings
echo "Configuring app settings"
# Retry to avoid transient 409 conflicts during initial provisioning
for attempt in 1 2 3 4 5; do
  if az webapp config appsettings set -g "$RG" -n "$WEBAPP_NAME" --settings \
    NODE_ENV=production \
    SCM_DO_BUILD_DURING_DEPLOYMENT=true \
    AZURE_STORAGE_ACCOUNT="$SA_NAME" \
    AZURE_STORAGE_CONTAINER=updates \
    UPDATE_MANIFEST_BLOB=manifest.json \
    PER_REQUEST_SAS_TTL_SEC=900 \
    AZURE_STORAGE_CONNECTION_STRING="$CONN_STRING" >/dev/null; then
    break
  fi
  echo "App settings update conflict; retrying ($attempt/5) ..."
  sleep 5
done

# Always On + logs
az webapp config set -g "$RG" -n "$WEBAPP_NAME" --always-on true >/dev/null || true
az webapp log config -g "$RG" -n "$WEBAPP_NAME" \
  --application-logging filesystem \
  --detailed-error-messages true \
  --failed-request-tracing true >/dev/null

# Build a minimal deploy package (only server and package files)
STAGE_DIR="$(mktemp -d -t hlstage-XXXXXXXX)"
cp -f update_server.js "$STAGE_DIR/" 2>/dev/null || true
cp -f package.json "$STAGE_DIR/" 2>/dev/null || true
cp -f package-lock.json "$STAGE_DIR/" 2>/dev/null || true
[ -f Procfile ] && cp -f Procfile "$STAGE_DIR/" || true

TMP_ZIP="$(mktemp -t hlupdate-XXXXXXXX).zip"
(cd "$STAGE_DIR" && zip -r "$TMP_ZIP" . >/dev/null)

if az webapp deploy --help >/dev/null 2>&1; then
  az webapp deploy -g "$RG" -n "$WEBAPP_NAME" --src-path "$TMP_ZIP" --type zip --clean true >/dev/null
else
  az webapp deployment source config-zip -g "$RG" -n "$WEBAPP_NAME" --src "$TMP_ZIP" >/dev/null
fi

az webapp restart -g "$RG" -n "$WEBAPP_NAME" >/dev/null

echo "Done. Health URL:"
echo "https://${WEBAPP_NAME}.azurewebsites.net/health"
echo
echo "Upload your manifest to Storage:"
echo "az storage blob upload --account-name $SA_NAME --auth-mode login --container-name updates --file manifest.example.json --name manifest.json --overwrite"