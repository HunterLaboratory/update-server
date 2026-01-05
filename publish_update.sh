#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Publish an update by uploading files to Azure Blob Storage and updating manifest.json.

Delete an update by removing it from manifest.json and deleting associated blobs.

Required:
  --product <desktop|instrument|recovery>
  --version <x.y.z>               (semver for comparison, e.g. "2.22.3")
  --notes <path-to-release-notes>

Desktop (provide one or more):
  [--windows <path>] [--macos <path>] [--linux <path>] [--default <path>]

Instrument/Recovery:
  --file <path>

Optional metadata:
  [--display-version <string>]    (shown to users, e.g. "2025.3.rc9")
  [--required] [--release-date <ISO>]
  [--model <agera|colorflex|vista>]   (instrument only)
  [--channel <production|preview>]

Delete mode:
  --delete                        (switch into delete mode)
  (interactive selection is always used)
  [--version <x.y.z>]             (optional filter)
  [--model <agera|colorflex|vista>]   (instrument filter)
  [--channel <production|preview>]    (optional filter; if omitted, shows all channels)

Azure discovery (overrides available):
  [--resource-group <name>] [--app <webapp-name>]  (reads storage settings from app)
  [--storage-account <name>] [--connection-string <conn>] [--container <name>]

Examples:
  # Desktop (Windows only)
  ./publish_update.sh --product desktop --version 2.3.0 \
    --windows "/path/EssentialsDesktop-2.3.0-Setup.exe" \
    --notes "/path/desktop-2.3.0-notes.md"

  # Instrument (ColorFlex) with display version for RC build
  ./publish_update.sh --product instrument --version 2.3.0 \
    --display-version "2025.3.rc9" \
    --file "/path/essentials-colorflex-update.hunterlab" \
    --notes "/path/instrument-2.3.0-notes.md" --model colorflex
USAGE
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Error: $1 is required"; exit 1; }; }

require_cmd az
require_cmd jq

# Defaults
MODE="publish"   # publish|delete
CHANNEL_SET=false
PRODUCT=""
VERSION=""
DISPLAY_VERSION=""
NOTES_PATH=""
FILE_SINGLE=""
WIN_PATH=""
MAC_PATH=""
LINUX_PATH=""
DEFAULT_PATH=""
IS_REQUIRED=false
RELEASE_DATE=""
MODEL=""
CHANNEL="production"
RG="${RG:-HunterLabSoftware}"
APP="${APP:-}"   # optional; if empty, we will auto-detect
STORAGE_ACCOUNT="${AZURE_STORAGE_ACCOUNT:-}"
CONNECTION_STRING="${AZURE_STORAGE_CONNECTION_STRING:-}"
CONTAINER="${AZURE_STORAGE_CONTAINER:-updates}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) MODE="delete"; shift 1;;
    --product) PRODUCT="$2"; shift 2;;
    --version) VERSION="$2"; shift 2;;
    --display-version) DISPLAY_VERSION="$2"; shift 2;;
    --notes) NOTES_PATH="$2"; shift 2;;
    --file) FILE_SINGLE="$2"; shift 2;;
    --windows) WIN_PATH="$2"; shift 2;;
    --macos) MAC_PATH="$2"; shift 2;;
    --linux) LINUX_PATH="$2"; shift 2;;
    --default) DEFAULT_PATH="$2"; shift 2;;
    --required) IS_REQUIRED=true; shift 1;;
    --release-date) RELEASE_DATE="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --channel) CHANNEL_SET=true; CHANNEL="$2"; shift 2;;
    --resource-group) RG="$2"; shift 2;;
    --app) APP="$2"; shift 2;;
    --storage-account) STORAGE_ACCOUNT="$2"; shift 2;;
    --connection-string) CONNECTION_STRING="$2"; shift 2;;
    --container) CONTAINER="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1"; usage; exit 1;;
  esac
done

if [[ "$MODE" == "delete" ]]; then
  # If channel flag is not provided, show all channels in the picker
  if [[ "$CHANNEL_SET" == false ]]; then
    CHANNEL=""
  fi
fi

case "$PRODUCT" in
  desktop) :;;
  instrument|recovery) :;;
  *) echo "Invalid --product: $PRODUCT"; exit 1;;
esac

confirm() {
  local prompt="$1"
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

download_manifest() {
  local out="$1"
  set +e
  az storage blob download --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -n manifest.json -f "$out" --no-progress >/dev/null 2>&1
  local rc=$?
  set -e
  if [[ $rc -ne 0 || ! -s "$out" ]]; then
    echo '{"updates":[]}' > "$out"
  fi
}

blob_delete_if_exists() {
  local blob="$1"
  if [[ -z "$blob" ]]; then
    return 0
  fi
  az storage blob delete --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -n "$blob" >/dev/null 2>&1 || true
}

delete_release() {
  local tmp_current tmp_new ids count chosen_id sel
  tmp_current=$(mktemp)
  tmp_new=$(mktemp)

  download_manifest "$tmp_current"

  # Normalize shape and filter candidates
  ids=$(jq -r \
    --arg product "$PRODUCT" \
    --arg version "$VERSION" \
    --arg channel "$CHANNEL" \
    --arg model "$MODEL" '
    def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end;
    toObj
    | (.updates // [])
    | map(select(.product==$product))
    | (if $channel != "" then map(select((.channel // "production")==$channel)) else . end)
    | (if $model != "" then map(select((.model // "")==$model)) else . end)
    | (if $version != "" then map(select(.version==$version)) else . end)
    | to_entries
    | map(.key|tostring)
    | .[]
  ' "$tmp_current")

  count=$(printf "%s\n" "$ids" | awk 'NF{c++} END{print c+0}')

  echo "Available matching releases:"
  jq -r \
    --arg product "$PRODUCT" \
    --arg version "$VERSION" \
    --arg channel "$CHANNEL" \
    --arg model "$MODEL" '
    def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end;
    toObj
    | (.updates // [])
    | map(select(.product==$product))
    | (if $channel != "" then map(select((.channel // "production")==$channel)) else . end)
    | (if $model != "" then map(select((.model // "")==$model)) else . end)
    | (if $version != "" then map(select(.version==$version)) else . end)
    | to_entries
    | .[]
    | "\(.key)\t\(.value.product)\t\(.value.version)\t\(.value.channel // "production")\t\(.value.model // "")\t\(.value.displayVersion // "")"
  ' "$tmp_current" | awk 'BEGIN{FS="\t"} {printf "%3d) version=%s channel=%s model=%s display=%s (id=%s)\n", NR, $3, $4, $5, $6, $1}'

  if [[ "$count" -eq 0 ]]; then
    echo "No matching releases found."
    return 0
  fi

  read -r -p "Choose a number to delete (or blank to cancel): " sel
  if [[ -z "$sel" ]]; then
    echo "Cancelled."
    return 0
  fi
  if ! echo "$sel" | grep -Eq '^[0-9]+$'; then
    echo "Invalid selection."; exit 1
  fi
  chosen_id=$(jq -r \
    --arg product "$PRODUCT" \
    --arg version "$VERSION" \
    --arg channel "$CHANNEL" \
    --arg model "$MODEL" '
    def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end;
    toObj
    | (.updates // [])
    | map(select(.product==$product))
    | (if $channel != "" then map(select((.channel // "production")==$channel)) else . end)
    | (if $model != "" then map(select((.model // "")==$model)) else . end)
    | (if $version != "" then map(select(.version==$version)) else . end)
    | to_entries
    | .['"$sel"' - 1].key // empty
  ' "$tmp_current")
  if [[ -z "$chosen_id" ]]; then
    echo "Selection out of range."; exit 1
  fi

  # Summarize what we're about to delete (blobs)
  local summary
  summary=$(jq -r \
    --argjson idx "$chosen_id" '
      def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end;
      toObj
      | (.updates // [])
      | .[$idx]
      | "product=\(.product) version=\(.version) channel=\(.channel // "production") model=\(.model // "")\n" +
        "notes=\(.releaseNotes // "")\n" +
        "file=\(.file // "")\n" +
        "files.windows=\(.files.windows // "")\n" +
        "files.macos=\(.files.macos // "")\n" +
        "files.linux=\(.files.linux // "")\n" +
        "files.default=\(.files.default // "")"
    ' "$tmp_current")

  echo "$summary"
  if ! confirm "Delete this release (manifest + blobs)?" ; then
    echo "Cancelled."
    return 0
  fi

  # Delete blobs referenced by entry
  local notes one win mac lin def
  notes=$(jq -r --argjson idx "$chosen_id" 'def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end; toObj | (.updates // []) | .[$idx].releaseNotes // empty' "$tmp_current")
  one=$(jq -r   --argjson idx "$chosen_id" 'def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end; toObj | (.updates // []) | .[$idx].file // empty' "$tmp_current")
  win=$(jq -r   --argjson idx "$chosen_id" 'def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end; toObj | (.updates // []) | .[$idx].files.windows // empty' "$tmp_current")
  mac=$(jq -r   --argjson idx "$chosen_id" 'def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end; toObj | (.updates // []) | .[$idx].files.macos // empty' "$tmp_current")
  lin=$(jq -r   --argjson idx "$chosen_id" 'def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end; toObj | (.updates // []) | .[$idx].files.linux // empty' "$tmp_current")
  def=$(jq -r   --argjson idx "$chosen_id" 'def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end; toObj | (.updates // []) | .[$idx].files.default // empty' "$tmp_current")

  blob_delete_if_exists "$notes"
  blob_delete_if_exists "$one"
  blob_delete_if_exists "$win"
  blob_delete_if_exists "$mac"
  blob_delete_if_exists "$lin"
  blob_delete_if_exists "$def"

  # Remove the entry and upload updated manifest
  jq \
    --argjson idx "$chosen_id" '
      def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end;
      toObj
      | .updates = ((.updates // []) | to_entries | map(select(.key != $idx)) | map(.value))
    ' "$tmp_current" > "$tmp_new"

  echo "Uploading updated manifest.json"
  az storage blob upload --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -f "$tmp_new" -n manifest.json --overwrite --content-type application/json >/dev/null
  echo "Done. Deleted release."
}

# Discover storage from App Service if not explicitly provided
if [[ -z "$STORAGE_ACCOUNT" || -z "$CONNECTION_STRING" ]]; then
  if [[ -z "$APP" ]]; then
    # Prefer our standard app name; fallback to most recently modified app in the RG
    if az webapp show -g "$RG" -n hunterlab-update-server >/dev/null 2>&1; then
      APP="hunterlab-update-server"
    else
      APP=$(az webapp list -g "$RG" --query "sort_by(@, &lastModifiedTimeUtc)[-1].name" -o tsv)
    fi
  fi
  if [[ -z "$STORAGE_ACCOUNT" ]]; then
    STORAGE_ACCOUNT=$(az webapp config appsettings list -g "$RG" -n "$APP" --query "[?name=='AZURE_STORAGE_ACCOUNT'].value | [0]" -o tsv)
  fi
  if [[ -z "$CONNECTION_STRING" ]]; then
    CONNECTION_STRING=$(az storage account show-connection-string -g "$RG" -n "$STORAGE_ACCOUNT" --query connectionString -o tsv)
  fi
fi

# Guard: ensure we actually resolved storage
if [[ -z "$STORAGE_ACCOUNT" || -z "$CONNECTION_STRING" ]]; then
  echo "Error: Could not resolve storage from app '$APP' in RG '$RG'. Pass --storage-account/--connection-string explicitly or verify the app settings."
  exit 1
fi

echo "Using storage: $STORAGE_ACCOUNT container=$CONTAINER"

# Ensure container exists
az storage container create --connection-string "$CONNECTION_STRING" -n "$CONTAINER" >/dev/null

# Mode validation after storage is resolved (so delete can still discover storage)
if [[ "$MODE" == "delete" ]]; then
  if [[ -z "$PRODUCT" ]]; then
    echo "Missing required arguments for delete: --product"; usage; exit 1;
  fi
  # VERSION is optional in delete mode (interactive selection)
  delete_release
  exit 0
fi

if [[ -z "$PRODUCT" || -z "$VERSION" || -z "$NOTES_PATH" ]]; then
  echo "Missing required arguments"; usage; exit 1;
fi

if [[ "$PRODUCT" == "desktop" ]]; then
  if [[ -z "$WIN_PATH$MAC_PATH$LINUX_PATH$DEFAULT_PATH" ]]; then
    echo "For desktop, provide at least one of --windows/--macos/--linux/--default"; exit 1
  fi
else
  if [[ -z "$FILE_SINGLE" ]]; then
    echo "For $PRODUCT, --file is required"; exit 1
  fi
fi

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
NOW_ISO=${RELEASE_DATE:-$(date -u +%Y-%m-%dT%H:%M:%S+00:00)}
REQ_BOOL=$([[ "$IS_REQUIRED" == true ]] && echo true || echo false)

if [[ "$PRODUCT" == "desktop" ]]; then
  ENTRY=$(jq -n \
    --arg product "$PRODUCT" \
    --arg version "$VERSION" \
    --arg displayVersion "$DISPLAY_VERSION" \
    --arg channel "$CHANNEL" \
    --argjson isRequired "$REQ_BOOL" \
    --arg releaseDate "$NOW_ISO" \
    --arg notesBlob "$NOTES_BLOB" \
    --argjson files "$FILES_JSON" \
    '{product: $product, version: $version, channel: $channel, isRequired: $isRequired, files: $files, releaseDate: $releaseDate, releaseNotes: $notesBlob}
     | if $displayVersion != "" then . + {displayVersion: $displayVersion} else . end')
else
  # Build JSON with conditional model field
  if [[ -n "$MODEL" ]]; then
    ENTRY=$(jq -n \
      --arg product "$PRODUCT" \
      --arg version "$VERSION" \
      --arg displayVersion "$DISPLAY_VERSION" \
      --arg channel "$CHANNEL" \
      --arg model "$MODEL" \
      --arg file "$ONE_BLOB" \
      --arg releaseDate "$NOW_ISO" \
      --arg notesBlob "$NOTES_BLOB" \
      --argjson isRequired "$REQ_BOOL" \
      '{product: $product, version: $version, channel: $channel, model: $model, isRequired: $isRequired, file: $file, releaseDate: $releaseDate, releaseNotes: $notesBlob}
       | if $displayVersion != "" then . + {displayVersion: $displayVersion} else . end')
  else
    ENTRY=$(jq -n \
      --arg product "$PRODUCT" \
      --arg version "$VERSION" \
      --arg displayVersion "$DISPLAY_VERSION" \
      --arg channel "$CHANNEL" \
      --arg file "$ONE_BLOB" \
      --arg releaseDate "$NOW_ISO" \
      --arg notesBlob "$NOTES_BLOB" \
      --argjson isRequired "$REQ_BOOL" \
      '{product: $product, version: $version, channel: $channel, isRequired: $isRequired, file: $file, releaseDate: $releaseDate, releaseNotes: $notesBlob}
       | if $displayVersion != "" then . + {displayVersion: $displayVersion} else . end')
  fi
fi

# Download current manifest (if exists)
TMP_CURRENT=$(mktemp)
set +e
az storage blob download --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -n manifest.json -f "$TMP_CURRENT" --no-progress >/dev/null 2>&1
DL_RC=$?
set -e

# If missing or empty, seed a valid empty manifest
if [[ $DL_RC -ne 0 || ! -s "$TMP_CURRENT" ]]; then
  echo '{"updates":[]}' > "$TMP_CURRENT"
fi

# Replace/merge with robust normalization in one step
TMP_NEW=$(mktemp)
jq --argjson entry "$ENTRY" '
  def toObj: if type=="array" then {updates:.} elif type=="object" then . else {updates: []} end;
  toObj
  | .updates = (
      ((.updates // []) + [$entry])
      | unique_by(.product + ":" + (.model // "") + ":" + .version)
    )
' "$TMP_CURRENT" > "$TMP_NEW"

echo "Uploading updated manifest.json"
az storage blob upload --connection-string "$CONNECTION_STRING" -c "$CONTAINER" -f "$TMP_NEW" -n manifest.json --overwrite --content-type application/json >/dev/null

echo "Done. Published $PRODUCT $VERSION"

if [[ -z "${APP:-}" ]]; then
  if az webapp show -g "$RG" -n hunterlab-update-server >/dev/null 2>&1; then
    APP="hunterlab-update-server"
  else
    APP=$(az webapp list -g "$RG" --query "sort_by(@, &lastModifiedTimeUtc)[-1].name" -o tsv)
  fi
fi
HOST=$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)
echo "Verify endpoints:" 
echo "  curl -sS https://$HOST/health | jq"
case "$PRODUCT" in
  desktop)
    echo "  curl -sS -H 'Content-Type: application/json' -d '{\"currentVersion\":\"$VERSION\",\"platform\":\"windows\",\"channel\":\"$CHANNEL\"}' https://$HOST/desktop-update | jq";;
  instrument)
    if [[ -n "$MODEL" ]]; then
      echo "  curl -sS -H 'Content-Type: application/json' -d '{\"currentVersion\":\"$VERSION\",\"platform\":\"android\",\"model\":\"$MODEL\",\"channel\":\"$CHANNEL\"}' https://$HOST/instrument-update | jq"
    else
      echo "  curl -sS -H 'Content-Type: application/json' -d '{\"currentVersion\":\"$VERSION\",\"platform\":\"android\",\"channel\":\"$CHANNEL\"}' https://$HOST/instrument-update | jq"
    fi;;
  recovery)
    echo "  curl -sS -H 'Content-Type: application/json' -d '{\"currentVersion\":\"$VERSION\",\"platform\":\"android\",\"channel\":\"$CHANNEL\"}' https://$HOST/recovery-update | jq";;
esac


