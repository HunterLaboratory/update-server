# HunterLab Essentials Update Server

## Prerequisites
- Azure CLI (`az`) and logged in
- jq
- Node.js 18+ locally (for dev)
- Access to Azure subscription and resource group

## Azure CLI Setup
```bash
# Login and select subscription
az login
```

## Deploying a new version of update_server.js
### Option A: One-liner helper script
```bash
# Defaults: RG=HunterLabSoftware, APP=hunterlab-update-server
chmod +x ./redeploy.sh
./redeploy.sh
```

## Using publish_update.sh
This uploads binaries and release notes to Azure Blob Storage and updates `manifest.json`.

Common flags (required unless noted):
- `--product <desktop|instrument|recovery>`
- `--version <x.y.z>`
- `--channel <production|preview>`
- `--notes </path/to/notes.md>`
- Desktop: `--windows </path> [--macos </path>] [--linux </path>] [--default </path>]`
- Instrument/Recovery: `--file </path/to/file>`
- Instrument only: `--model <agera|colorflex|vista>`
- Optional: `--required` (marks update as mandatory) `--release-date <ISO>`

Examples:
```bash
# Instrument
./publish_update.sh \
  --product instrument \
  --version 2.37.0 \
  --model colorflex \
  --channel production \
  --file "/path/to/essentials.hunterlab" \
  --notes "/path/to/notes.md"

# Desktop (Windows only example)
./publish_update.sh \
  --product desktop \
  --version 2.3.0 \
  --channel production \
  --windows "/path/to/EssentialsDesktop-2.3.0-Setup.exe" \
  --notes "/path/to/notes.md"

# Recovery
./publish_update.sh \
  --product recovery \
  --version 2.40.0 \
  --channel production \
  --file "/path/to/essentials-recovery-update.hunterlab" \
  --notes "/path/to/notes.md"
```
What it does:
- Ensures container exists
- Uploads release notes and file(s)
- Dedupes by `product:model:version` and updates `manifest.json`
- Uploads `manifest.json`

Verify endpoints:
```