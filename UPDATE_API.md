# Update Server API Documentation

## Overview

The update server supports multiple product types, instrument models, and release channels for distributing software updates.

## Products

- **desktop**: Desktop application updates
- **instrument**: Device-specific instrument updates (Agera, ColorFlex, Vista)
- **recovery**: Recovery image updates

## Instrument Models

For instrument updates, the following models are supported:
- `agera`
- `colorflex`
- `vista`

## Release Channels

All products support multiple release channels:
- `production` (default): Stable releases
- `preview`: Preview/testing releases

## API Endpoints

### POST /instrument-update

Check for instrument updates.

**Request Body:**
```json
{
  "currentVersion": "2.40.5",
  "platform": "linux",
  "model": "agera",
  "channel": "production"
}
```

**Parameters:**
- `currentVersion` (required): Current installed version
- `platform` (optional): Platform identifier
- `model` (optional): Instrument model (agera, colorflex, vista)
- `channel` (optional): Release channel (production or preview, defaults to production)

**Response:**
```json
{
  "hasUpdate": true,
  "updateInfo": {
    "version": "2.40.7",
    "releaseNotes": "...",
    "releaseNotesUrl": "/api/release-notes?product=instrument&version=2.40.7&model=agera",
    "isRequired": false,
    "downloadUrl": "https://...",
    "model": "agera",
    "channel": "production",
    "releaseDate": "2025-09-15T00:00:00Z"
  }
}
```

### POST /desktop-update

Check for desktop updates.

**Request Body:**
```json
{
  "currentVersion": "2.2.0",
  "platform": "windows",
  "channel": "preview"
}
```

### POST /recovery-update

Check for recovery updates.

**Request Body:**
```json
{
  "currentVersion": "2.40.0",
  "platform": "linux",
  "channel": "production"
}
```

### GET /api/releases

List all releases for a product.

**Query Parameters:**
- `product` (required): Product type (desktop, instrument, recovery)
- `model` (optional): Instrument model (for instrument products only)
- `channel` (optional): Release channel (defaults to production)

**Examples:**
```
GET /api/releases?product=instrument&model=agera&channel=production
GET /api/releases?product=desktop&channel=preview
GET /api/releases?product=recovery
```

**Response:**
```json
{
  "product": "instrument",
  "model": "agera",
  "channel": "production",
  "releases": [
    {
      "version": "2.40.7",
      "date": "2025-09-15T00:00:00Z",
      "title": "instrument 2.40.7",
      "required": false,
      "model": "agera",
      "channel": "production",
      "notesUrl": "/api/release-notes?product=instrument&version=2.40.7&model=agera"
    }
  ]
}
```

### GET /api/release-notes

Get release notes for a specific version.

**Query Parameters:**
- `product` (required): Product type
- `version` (optional): Specific version (defaults to latest)
- `model` (optional): Instrument model
- `channel` (optional): Release channel (defaults to production)

**Examples:**
```
GET /api/release-notes?product=instrument&version=2.40.7&model=agera
GET /api/release-notes?product=desktop&channel=preview
```

**Response:**
```json
{
  "product": "instrument",
  "version": "2.40.7",
  "model": "agera",
  "channel": "production",
  "url": null,
  "content": "# Release Notes...",
  "expiresAt": "2025-10-06T12:00:00Z"
}
```

Note: `expiresAt` reflects a short‑lived access window (default ~15 minutes) for any signed links/content.

## Manifest Structure

The manifest file (`manifest.json`) should include entries with the following fields:

```json
{
  "updates": [
    {
      "product": "instrument",
      "model": "agera",
      "version": "2.40.7",
      "channel": "production",
      "releaseDate": "2025-09-15T00:00:00Z",
      "isRequired": false,
      "file": "essentials-agera-update.hunterlab",
      "releaseNotes": "instrument-agera-2.40.7-notes.md"
    }
  ]
}
```

### Manifest Fields

- `product` (required): Product type (desktop, instrument, recovery)
- `model` (optional): Instrument model (required for instrument products)
- `version` (required): Semantic version number
- `channel` (optional): Release channel (defaults to production)
- `releaseDate` (required): ISO 8601 date string with timezone
- `isRequired` (optional): Whether update is mandatory (defaults to false)
- `file` (optional): Blob name for single file (instruments, recovery)
- `files` (optional): Platform-specific file map (desktop)
- `releaseNotes` (optional): Blob name for release notes markdown file

### Uniqueness and deduplication

- To support multiple instrument models for the same version, use one manifest entry per model (unique by `product + version + model`).
- If you use the helper publishing script, it currently de‑duplicates entries by `product + version` (last write wins). Publishing another model with the same version will replace the previous one. Adjust your process or the script if you need parallel model entries per version.

## Migration Guide

### For Existing Instrument Updates

Old manifest entry:
```json
{
  "product": "instrument",
  "version": "2.40.5",
  "file": "essentials-update.hunterlab"
}
```

New manifest entries (one per model):
```json
{
  "product": "instrument",
  "model": "agera",
  "version": "2.40.5",
  "channel": "production",
  "releaseDate": "2025-09-15T00:00:00Z",
  "isRequired": false,
  "file": "essentials-agera-update.hunterlab",
  "releaseNotes": "instrument-agera-2.40.5-notes.md"
},
{
  "product": "instrument",
  "model": "colorflex",
  "version": "2.40.5",
  "channel": "production",
  "releaseDate": "2025-09-20T00:00:00Z",
  "isRequired": false,
  "file": "essentials-colorflex-update.hunterlab",
  "releaseNotes": "instrument-colorflex-2.40.5-notes.md"
},
{
  "product": "instrument",
  "model": "agera",
  "version": "2.41.0-preview.1",
  "channel": "preview",
  "releaseDate": "2025-10-01T00:00:00Z",
  "isRequired": false,
  "file": "essentials-agera-update-preview.hunterlab",
  "releaseNotes": "instrument-agera-2.41.0-preview.1-notes.md"
}
```

### For Client Applications

Update your client code to specify the model and channel:

```javascript
// Old
const response = await fetch('/instrument-update', {
  method: 'POST',
  body: JSON.stringify({
    currentVersion: '2.40.5'
  })
});

// New
const response = await fetch('/instrument-update', {
  method: 'POST',
  body: JSON.stringify({
    currentVersion: '2.40.5',
    model: 'agera',
    channel: 'production'
  })
});
```

## Backward Compatibility

- If `model` is not specified for instrument updates, the server will return updates without filtering by model (legacy behavior)
- If `channel` is not specified, the server defaults to the `production` channel
- Manifest entries without a `channel` field are treated as `production` channel releases

