const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, SASProtocol, StorageSharedKeyCredential } = require("@azure/storage-blob");

const app = express();
const port = process.env.PORT || 3000;

// Azure config
const storageAccount = process.env.AZURE_STORAGE_ACCOUNT;
const containerName = process.env.AZURE_STORAGE_CONTAINER || "updates";
const blobBaseUrl = storageAccount
  ? `https://${storageAccount}.blob.core.windows.net/${containerName}`
  : null;
const manifestBlobName = process.env.UPDATE_MANIFEST_BLOB || "manifest.json";
const storageSas = process.env.AZURE_STORAGE_SAS || "";
const perRequestSasTtlSec = parseInt(process.env.PER_REQUEST_SAS_TTL_SEC || "900", 10); // 15 min default

function parseConnectionString(conn) {
  if (!conn) return {};
  const parts = Object.fromEntries(
    conn.split(";").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    })
  );
  return { accountName: parts.AccountName, accountKey: parts.AccountKey };
}

const { accountName: parsedAccountName, accountKey } = parseConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const accountName = storageAccount || parsedAccountName;

function appendSas(url) {
  if (!storageSas) return url;
  // storageSas may already start with '?'
  return `${url}${storageSas.startsWith('?') ? storageSas : `?${storageSas}`}`;
}

function buildBlobUrl(blobName) {
  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}`;
}

function signBlobUrl(blobName) {
  // Prefer per-request SAS if we have the account key; fallback to container SAS if provided
  if (accountName && accountKey) {
    try {
      const sharedKey = new StorageSharedKeyCredential(accountName, accountKey);
      const now = new Date();
      const startsOn = new Date(now.valueOf() - 5 * 60 * 1000); // clock skew
      const expiresOn = new Date(now.valueOf() + perRequestSasTtlSec * 1000);
      const sas = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          permissions: BlobSASPermissions.parse("r"),
          startsOn,
          expiresOn,
          protocol: SASProtocol.Https,
        },
        sharedKey
      ).toString();
      return `${buildBlobUrl(blobName)}?${sas}`;
    } catch (e) {
      console.warn("Failed to generate per-request SAS, falling back to AZURE_STORAGE_SAS:", e.message);
    }
  }
  return appendSas(`${buildBlobUrl(blobName)}`);
}

// Enable CORS and JSON
app.use(cors());
app.use(express.json());

// Local static fallback for downloads
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

// Health endpoint
app.get(["/", "/health"], async (req, res) => {
  const downloadsDir = path.join(__dirname, "downloads");
  let availableFiles = [];

  try {
    if (fs.existsSync(downloadsDir)) {
      availableFiles = fs
        .readdirSync(downloadsDir)
        .filter((file) =>
          [".hunterlab", ".exe", ".pkg", ".dmg", ".appimage", ".apk"].some(
            (ext) => file.toLowerCase().endsWith(ext)
          )
        )
        .map((file) => {
          const filePath = path.join(downloadsDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            size: stats.size,
            modified: stats.mtime,
            url: `${getBaseUrl(req)}/downloads/${file}`,
          };
        });
    }
  } catch (err) {
    console.error("Error reading downloads directory:", err);
  }

  res.json({
    status: "ok",
    port,
    environment: process.env.NODE_ENV || "development",
    storage: storageAccount
      ? { type: "azure-blob", account: storageAccount, container: containerName }
      : { type: "local" },
    availableFiles,
    scenarios: ["has_update", "no_update", "forced", "error"],
  });
});

// List releases for a product (from manifest)
app.get("/api/releases", async (req, res) => {
  try {
    const product = (req.query.product || "").toString();
    if (!product) {
      return res.status(400).json({ error: "Missing required query param: product" });
    }

    const manifest = await loadManifest();
    if (!manifest) {
      return res.status(404).json({ error: "Manifest not found" });
    }

    const updates = (manifest.updates || []).filter((u) => u.product === product);
    if (!updates.length) {
      return res.json({ product, releases: [] });
    }

    const releases = updates
      .map((u) => ({
        version: u.version,
        date: u.releaseDate || new Date().toISOString(),
        title: u.displayName || u.description || `${product} ${u.version}`,
        required: !!u.isRequired,
        notesUrl: `${getBaseUrl(req)}/api/release-notes?product=${encodeURIComponent(product)}&version=${encodeURIComponent(u.version)}`,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return res.json({ product, releases });
  } catch (e) {
    console.error("Error in /api/releases:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint: Desktop (new and legacy)
app.post("/desktop-update", async (req, res) => {
  await handleUpdateCheck(req, res, { product: "desktop" });
});


// Endpoint: Instrument (new and legacy)
app.post("/instrument-update", async (req, res) => {
  await handleUpdateCheck(req, res, { product: "instrument" });
});


// Endpoint: Recovery (new and legacy)
app.post("/recovery-update", async (req, res) => {
  await handleUpdateCheck(req, res, { product: "recovery" });
});


// Endpoint: Release notes (signed URL and/or inline), usable by apps and websites
app.get("/api/release-notes", async (req, res) => {
  try {
    const product = (req.query.product || "").toString();
    const version = req.query.version ? req.query.version.toString() : null;
    if (!product) {
      return res.status(400).json({ error: "Missing required query param: product" });
    }

    const manifest = await loadManifest();
    if (!manifest) {
      return res.status(404).json({ error: "Manifest not found" });
    }

    const candidates = (manifest.updates || []).filter((u) => u.product === product);
    if (!candidates.length) {
      return res.status(404).json({ error: `No release notes configured for product '${product}'` });
    }

    const entry = version
      ? candidates.find((u) => u.version === version) || candidates[0]
      : candidates[0];

    const rn = await resolveReleaseNotes(entry);
    if (!rn) {
      return res.status(404).json({ error: "Release notes not available" });
    }

    const now = new Date();
    const expiresAt = new Date(now.valueOf() + perRequestSasTtlSec * 1000).toISOString();
    return res.json({
      product,
      version: entry.version,
      url: rn.url || null,
      content: rn.content || null,
      expiresAt,
    });
  } catch (e) {
    console.error("Error in /api/release-notes:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Core update handler using manifest
async function handleUpdateCheck(req, res, { product }) {
  const scenario = process.env.UPDATE_SCENARIO || req.query.scenario || "has_update";
  const { currentVersion, platform } = req.body || {};

  try {
    if (scenario === "error") {
      return res.status(500).json({ error: "Update server temporarily unavailable" });
    }

    const manifest = await loadManifest();
    if (!manifest) {
      return res.status(404).json({ hasUpdate: false, currentVersion, message: "No manifest configured" });
    }

    const candidates = (manifest.updates || []).filter((u) => u.product === product);
    if (!candidates.length) {
      return res.json({ hasUpdate: false, currentVersion, message: "No updates configured" });
    }

    // Pick latest entry by releaseDate (fallback to highest semantic version)
    const entry = candidates.sort((a, b) => {
      const ad = new Date(a.releaseDate || 0).getTime();
      const bd = new Date(b.releaseDate || 0).getTime();
      if (ad !== bd) return bd - ad;
      return isNewerVersion(b.version, a.version) ? 1 : -1;
    })[0];

    // Determine if update is applicable relative to client version
    const targetVersion = entry.version;
    const isRequired = !!entry.isRequired;
    const hasUpdate = scenario === "no_update" ? false : isNewerVersion(targetVersion, currentVersion);

    if (!hasUpdate) {
      return res.json({ hasUpdate: false, currentVersion, message: "You are running the latest version" });
    }

    const downloadUrl = resolveDownloadUrl(entry, platform);
    const releaseNotes = await resolveReleaseNotes(entry);
    // Prefer server endpoint URL for release notes so clients and websites can fetch short-lived SAS
    const notesEndpointUrl = `${getBaseUrl(req)}/api/release-notes?product=${encodeURIComponent(product)}&version=${encodeURIComponent(targetVersion)}`;

    return res.json({
      hasUpdate: true,
      updateInfo: {
        version: targetVersion,
        displayName: entry.displayName,
        description: entry.description,
        releaseNotes: releaseNotes?.content,
        releaseNotesUrl: notesEndpointUrl,
        features: entry.features,
        isRequired,
        downloadUrl,
        instrumentModel: entry.instrumentModel,
        releaseDate: entry.releaseDate,
      },
    });
  } catch (error) {
    console.error("Error processing update check:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

function getBaseUrl(req) {
  const protocol = req.get("X-Forwarded-Proto") || req.protocol;
  const host = req.get("X-Forwarded-Host") || req.get("Host");
  return `${protocol}://${host}`;
}

function isNewerVersion(a, b) {
  if (!a || !b) return true;
  const ap = a.split(".").map((n) => parseInt(n, 10));
  const bp = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const ai = ap[i] || 0;
    const bi = bp[i] || 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

function getDesktopFileName(platform, isForced) {
  const version = isForced ? "2.2.0-critical" : "2.2.0";
  switch ((platform || "").toLowerCase()) {
    case "windows":
      return `EssentialsDesktop-${version}-Setup.exe`;
    case "macos":
    case "darwin":
      return `EssentialsDesktop-${version}.pkg`;
    case "linux":
      return `EssentialsDesktop-${version}.AppImage`;
    default:
      return `EssentialsDesktop-${version}.zip`;
  }
}

function resolveDownloadUrl(entry, platform) {
  // Prefer Azure Blob when configured (ignore manifest downloadUrl to avoid stale/non-SAS links)
  if (storageAccount) {
    if (entry.product === "desktop") {
      const map = entry.files || {};
      const key = (platform || "").toLowerCase();
      const blobName = map[key] || map.default || getDesktopFileName(platform, !!entry.isRequired);
      return signBlobUrl(blobName);
    }
    if (entry.product === "instrument") return signBlobUrl(entry.file || "essentials-update.hunterlab");
    if (entry.product === "recovery") return signBlobUrl(entry.file || "essentials-recovery-update.hunterlab");
  }
  // If no Azure storage configured, honor explicit manifest URL if provided
  if (entry.downloadUrl) return entry.downloadUrl;
  // Local fallback
  if (entry.product === "desktop") return `/downloads/${getDesktopFileName(platform, !!entry.isRequired)}`;
  if (entry.product === "instrument") return `/downloads/${entry.file || "essentials-update.hunterlab"}`;
  if (entry.product === "recovery") return `/downloads/${entry.file || "essentials-recovery-update.hunterlab"}`;
}

async function resolveReleaseNotes(entry) {
  if (entry.releaseNotes?.content) return { content: entry.releaseNotes.content };

  const blobName = entry.releaseNotes?.blob || entry.releaseNotesBlob;
  const explicitUrl = entry.releaseNotes?.url || null;

  // If we have a blob name and storage, prefer generating a signed URL
  if (storageAccount && blobName) {
    const signed = signBlobUrl(blobName);
    if (entry.releaseNotes?.inline === true) {
      try {
        const content = await downloadBlobText(blobName);
        return { content, url: signed };
      } catch (e) {
        console.warn("Failed to inline release notes, falling back to URL:", e.message);
        return { url: signed };
      }
    }
    return { url: signed };
  }

  // If only an explicit URL is provided, try to sign it when it points to this storage account and lacks a query
  if (explicitUrl) {
    try {
      const u = new URL(explicitUrl);
      const isOurAccount = storageAccount && u.hostname === `${storageAccount}.blob.core.windows.net`;
      const hasQuery = !!u.search && u.search.length > 1;
      if (isOurAccount && !hasQuery) {
        // Extract blob name relative to container
        const path = u.pathname; // e.g. /updates/instrument-notes.md
        const expectedPrefix = `/${containerName}/`;
        if (path.startsWith(expectedPrefix)) {
          const blobFromUrl = path.substring(expectedPrefix.length);
          const signed = signBlobUrl(blobFromUrl);
          return { url: signed };
        }
      }
    } catch (_) {}
    return { url: explicitUrl };
  }

  return null;
}

async function loadManifest() {
  // Try Azure Blob manifest first
  if (storageAccount) {
    try {
      const text = await downloadBlobText(manifestBlobName);
      return JSON.parse(text);
    } catch (e) {
      console.warn("Manifest not found in Azure or failed to parse:", e.message);
    }
  }
  // Fallback to local manifest
  const localPath = path.join(__dirname, manifestBlobName);
  if (fs.existsSync(localPath)) {
    try {
      return JSON.parse(fs.readFileSync(localPath, "utf-8"));
    } catch (e) {
      console.warn("Local manifest failed to parse:", e.message);
    }
  }
  return null;
}

async function downloadBlobText(blobName) {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const url = `https://${storageAccount}.blob.core.windows.net`;
  const client = conn
    ? BlobServiceClient.fromConnectionString(conn)
    : new BlobServiceClient(`${url}${process.env.AZURE_STORAGE_SAS || ""}`);
  const containerClient = client.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  const download = await blobClient.download();
  return streamToString(download.readableStreamBody);
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (d) => chunks.push(d.toString()));
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", reject);
  });
}

// Error and 404 handlers
app.use((err, req, res, next) => {
  console.error("Server error:", err.stack);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    availableEndpoints: [
      "GET /health",
      "GET /api/release-notes?product=...&version=...",
      "POST /desktop-update",
      "POST /instrument_update",
      "POST /recovery-update",
    ],
  });
});

const server = app.listen(port, () => {
  console.log("🚀 HunterLab Essentials Update Server");
  console.log("=".repeat(50));
  console.log(`📡 Server running on port ${port}`);
  console.log(`☁️ Storage: ${storageAccount ? `azure://${storageAccount}/${containerName}` : "local"}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down gracefully...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});


