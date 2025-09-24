#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Publish an update by uploading files to Azure Blob Storage and updating manifest.json.

Required:
  --product <desktop|instrument|recovery>
  --version <x.y.z>
  --notes <path-to-release-notes>

Desktop (provide one or more):
  [--windows <path>] [--macos <path>] [--linux <path>] [--default <path>]

Instrument/Recovery:
  --file <path>

Optional metadata:
  [--display-name <name>] [--description <text>] [--required] [--release-date <ISO>]
  [--instrument-model <int>]   (instrument only)

Azure discovery (overrides available):
  [--resource-group <name>] [--app <webapp-name>]  (reads storage settings from app)
  [--storage-account <name>] [--connection-string <conn>] [--container <name>]

Examples:
  # Desktop (Windows only)
  ./publish_update.sh --product desktop --version 2.3.0 \
    --windows "/path/EssentialsDesktop-2.3.0-Setup.exe" \
    --notes "/path/desktop-2.3.0-notes.md"

  # Instrument
  ./publish_update.sh --product instrument --version 2.3.0 \
    --file "/path/essentials-update.hunterlab" \
    --notes "/path/instrument-2.3.0-notes.md" --instrument-model 0
USAGE
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Error: $1 is required"; exit 1; }; }

require_cmd az
require_cmd jq

# Defaults
PRODUCT=""
VERSION=""
NOTES_PATH=""
FILE_SINGLE=""
WIN_PATH=""
MAC_PATH=""
LINUX_PATH=""
DEFAULT_PATH=""
DISPLAY_NAME=""
DESCRIPTION=""
IS_REQUIRED=false
RELEASE_DATE=""
INSTR_MODEL=""
RG="${RG:-hl-essentials-rg}"
APP="${APP:-}"   # optional; if empty, we will auto-detect
STORAGE_ACCOUNT="${AZURE_STORAGE_ACCOUNT:-}"
CONNECTION_STRING="${AZURE_STORAGE_CONNECTION_STRING:-}"
CONTAINER="${AZURE_STORAGE_CONTAINER:-updates}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --product) PRODUCT="$2"; shift 2;;
    --version) VERSION="$2"; shift 2;;
    --notes) NOTES_PATH="$2"; shift 2;;
    --file) FILE_SINGLE="$2"; shift 2;;
    --windows) WIN_PATH="$2"; shift 2;;
    --macos) MAC_PATH="$2"; shift 2;;
    --linux) LINUX_PATH="$2"; shift 2;;
    --default) DEFAULT_PATH="$2"; shift 2;;
    --display-name) DISPLAY_NAME="$2"; shift 2;;
    --description) DESCRIPTION="$2"; shift 2;;
    --required) IS_REQUIRED=true; shift 1;;
    --release-date) RELEASE_DATE="$2"; shift 2;;
    --instrument-model) INSTR_MODEL="$2"; shift 2;;
    --resource-group) RG="$2"; shift 2;;
    --app) APP="$2"; shift 2;;
    --storage-account) STORAGE_ACCOUNT="$2"; shift 2;;
    --connection-string) CONNECTION_STRING="$2"; shift 2;;
    --container) CONTAINER="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1"; usage; exit 1;;
  esac
done

if [[ -z "$PRODUCT" || -z "$VERSION" || -z "$NOTES_PATH" ]]; then
  echo "Missing required arguments"; usage; exit 1;
fi

case "$PRODUCT" in
  desktop) :;;
  instrument|recovery) :;;
  *) echo "Invalid --product: $PRODUCT"; exit 1;;
esac

if [[ "$PRODUCT" == "desktop" ]]; then
  if [[ -z "$WIN_PATH$MAC_PATH$LINUX_PATH$DEFAULT_PATH" ]]; then
    echo "For desktop, provide at least one of --windows/--macos/--linux/--default"; exit 1
  fi
else
  if [[ -z "$FILE_SINGLE" ]]; then
    echo "For $PRODUCT, --file is required"; exit 1
  fi
fi

# Discover storage from App Service if not explicitly provided
if [[ -z "$STORAGE_ACCOUNT" || -z "$CONNECTION_STRING" ]]; then
  if [[ -z "$APP" ]]; then
    APP=$(az webapp list -g "$RG" --query "sort_by([?starts_with(name, 'hl-essentials-update-')], &lastModifiedTimeUtc)[-1].name" -o tsv)
  fi
  if [[ -z "$STORAGE_ACCOUNT" ]]; then
    STORAGE_ACCOUNT=$(az webapp config appsettings list -g "$RG" -n "$APP" --query "[?name=='AZURE_STORAGE_ACCOUNT'].value | [0]" -o tsv)
  fi
  if [[ -z "$CONNECTION_STRING" ]]; then
    CONNECTION_STRING=$(az storage account show-connection-string -g "$RG" -n "$STORAGE_ACCOUNT" --query connectionString -o tsv)
  fi
fi

echo "Using storage: $STORAGE_ACCOUNT container=$CONTAINER"

# Ensure container exists
az storage container create --connection-string "$CONNECTION_STRING" -n "$CONTAINER" >/dev/null

# Determine release notes blob name
NOTES_BASENAME=$(basename "$NOTES_PATH")
if [[ "$NOTES_BASENAME" != *"$PRODUCT-$VERSION"* ]]; then
  EXT=".${NOTES_BASENAME##*.}"
  NOTES_BLOB="${PRODUCT}-${VERSION}-notes${EXT}"
else
  NOTES_BLOB="$NOTES_BASENAME"
fi

echo "Uploading release notes: $NOTES_BLOB"
az storage blob upload --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -f "$NOTES_PATH" -n "$NOTES_BLOB" --overwrite >/dev/null

# Upload update files (compatible with macOS Bash 3.x)
FILES_JSON=$(jq -n '{}')
if [[ "$PRODUCT" == "desktop" ]]; then
  if [[ -n "$WIN_PATH" ]]; then
    WIN_BLOB=$(basename "$WIN_PATH"); echo "Uploading: $WIN_BLOB"; az storage blob upload --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -f "$WIN_PATH" -n "$WIN_BLOB" --overwrite >/dev/null
    FILES_JSON=$(echo "$FILES_JSON" | jq --arg v "$WIN_BLOB" '. + {windows: $v}')
  fi
  if [[ -n "$MAC_PATH" ]]; then
    MAC_BLOB=$(basename "$MAC_PATH"); echo "Uploading: $MAC_BLOB"; az storage blob upload --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -f "$MAC_PATH" -n "$MAC_BLOB" --overwrite >/dev/null
    FILES_JSON=$(echo "$FILES_JSON" | jq --arg v "$MAC_BLOB" '. + {macos: $v}')
  fi
  if [[ -n "$LINUX_PATH" ]]; then
    LINUX_BLOB=$(basename "$LINUX_PATH"); echo "Uploading: $LINUX_BLOB"; az storage blob upload --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -f "$LINUX_PATH" -n "$LINUX_BLOB" --overwrite >/dev/null
    FILES_JSON=$(echo "$FILES_JSON" | jq --arg v "$LINUX_BLOB" '. + {linux: $v}')
  fi
  if [[ -n "$DEFAULT_PATH" ]]; then
    DEF_BLOB=$(basename "$DEFAULT_PATH"); echo "Uploading: $DEF_BLOB"; az storage blob upload --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -f "$DEFAULT_PATH" -n "$DEF_BLOB" --overwrite >/dev/null
    FILES_JSON=$(echo "$FILES_JSON" | jq --arg v "$DEF_BLOB" '. + {default: $v}')
  fi
else
  ONE_BLOB=$(basename "$FILE_SINGLE"); echo "Uploading: $ONE_BLOB"; az storage blob upload --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -f "$FILE_SINGLE" -n "$ONE_BLOB" --overwrite >/dev/null
fi

# Build the new entry JSON using jq
NOW_ISO=${RELEASE_DATE:-$(date -u +%Y-%m-%d)}
REQ_BOOL=$([[ "$IS_REQUIRED" == true ]] && echo true || echo false)

if [[ "$PRODUCT" == "desktop" ]]; then
  ENTRY=$(jq -n \
    --arg product "$PRODUCT" \
    --arg version "$VERSION" \
    --arg displayName "${DISPLAY_NAME:-Essentials Desktop $VERSION}" \
    --arg description "${DESCRIPTION:-Desktop update}" \
    --argjson isRequired "$REQ_BOOL" \
    --arg releaseDate "$NOW_ISO" \
    --arg notesBlob "$NOTES_BLOB" \
    --argjson files "$FILES_JSON" \
    '{product: $product, version: $version, displayName: $displayName, description: $description, isRequired: $isRequired, files: $files, releaseDate: $releaseDate, features: [], releaseNotes: {inline: false, blob: $notesBlob}}')
else
  # Defaults for display name/description without Bash 4 ${var^}
  if [[ -z "$DISPLAY_NAME" ]]; then
    if [[ "$PRODUCT" == "instrument" ]]; then DISPLAY_NAME="Instrument $VERSION"; else DISPLAY_NAME="Recovery $VERSION"; fi
  fi
  if [[ -z "$DESCRIPTION" ]]; then
    if [[ "$PRODUCT" == "instrument" ]]; then DESCRIPTION="Instrument update"; else DESCRIPTION="Recovery update"; fi
  fi
  ENTRY=$(jq -n \
    --arg product "$PRODUCT" \
    --arg version "$VERSION" \
    --arg displayName "$DISPLAY_NAME" \
    --arg description "$DESCRIPTION" \
    --arg file "$ONE_BLOB" \
    --arg releaseDate "$NOW_ISO" \
    --arg notesBlob "$NOTES_BLOB" \
    --argjson isRequired "$REQ_BOOL" \
    --argjson instrumentModel "${INSTR_MODEL:-0}" \
    '{product: $product, version: $version, displayName: $displayName, description: $description, isRequired: $isRequired, file: $file, instrumentModel: $instrumentModel, releaseDate: $releaseDate, features: [], releaseNotes: {inline: false, blob: $notesBlob}}')
fi

# Download current manifest (if exists)
TMP_CURRENT=$(mktemp)
set +e
az storage blob download --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -n manifest.json -f "$TMP_CURRENT" --no-progress >/dev/null 2>&1
DL_RC=$?
set -e

# Replace/merge with robust normalization in one step
TMP_NEW=$(mktemp)
jq --argjson entry "$ENTRY" --arg product "$PRODUCT" '
  def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end;
  (input? // {updates: []}) as $fallback
  | (try (toObj) catch $fallback)
  | .updates = (
      ((.updates // []) + [$entry])
      | unique_by(.product + ":" + .version)
    )
' "$TMP_CURRENT" > "$TMP_NEW"

echo "Uploading updated manifest.json"
az storage blob upload --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -f "$TMP_NEW" -n manifest.json --overwrite >/dev/null

echo "Done. Published $PRODUCT $VERSION"

if [[ -z "${APP:-}" ]]; then
  APP=$(az webapp list -g "$RG" --query "sort_by([?starts_with(name, 'hl-essentials-update-')], &lastModifiedTimeUtc)[-1].name" -o tsv)
fi
HOST=$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)
echo "Verify endpoints:" 
echo "  curl -sS https://$HOST/health | jq"
case "$PRODUCT" in
  desktop)
    echo "  curl -sS -H 'Content-Type: application/json' -d '{\"currentVersion\":\"$VERSION\",\"platform\":\"windows\"}' https://$HOST/desktop-update | jq";;
  instrument)
    echo "  curl -sS -H 'Content-Type: application/json' -d '{\"currentVersion\":\"$VERSION\",\"platform\":\"android\"}' https://$HOST/instrument-update | jq";;
  recovery)
    echo "  curl -sS -H 'Content-Type: application/json' -d '{\"currentVersion\":\"$VERSION\",\"platform\":\"android\"}' https://$HOST/recovery-update | jq";;
esac


