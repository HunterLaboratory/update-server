const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, SASProtocol, StorageSharedKeyCredential } = require("@azure/storage-blob");

const app = express();
const port = process.env.PORT || 3000;
const isProduction = (process.env.NODE_ENV || "development").toLowerCase() === "production";

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

// Local static fallback for downloads (development only)
if (!isProduction) {
  app.use("/downloads", express.static(path.join(__dirname, "downloads")));
}

// Health endpoint
app.get(["/", "/health"], async (req, res) => {
  const downloadsDir = path.join(__dirname, "downloads");
  let availableFiles = [];

  // Only enumerate local sample files in non-production environments
  if (!isProduction) {
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
    products: {
      desktop: { channels: ["production", "preview"] },
      instrument: { 
        models: ["agera", "colorflex", "vista"],
        channels: ["production", "preview"]
      },
      recovery: { channels: ["production", "preview"] }
    },
    manifestSchema: {
      note: "Use 'version' for comparison (numeric only), 'displayVersion' for UI display",
      example: { version: "2025.3.9", displayVersion: "2025.3.0-rc9" }
    }
  });
});

// List releases for a product (from manifest)
app.get("/api/releases", async (req, res) => {
  try {
    const product = (req.query.product || "").toString();
    const model = req.query.model ? req.query.model.toString() : null;
    const channel = req.query.channel ? req.query.channel.toString() : "production";
    
    if (!product) {
      return res.status(400).json({ error: "Missing required query param: product" });
    }

    const manifest = await loadManifest();
    if (!manifest) {
      return res.status(404).json({ error: "Manifest not found" });
    }

    let updates = (manifest.updates || []).filter((u) => u.product === product);
    
    // Filter by model for instrument products
    if (model && product === "instrument") {
      updates = updates.filter((u) => u.model === model);
    }
    
    // Filter by channel
    updates = updates.filter((u) => (u.channel || "production") === channel);
    
    if (!updates.length) {
      return res.json({ product, model, channel, releases: [] });
    }

    const releases = updates
      .map((u) => ({
        version: u.displayVersion || u.version,
        date: u.releaseDate || new Date().toISOString(),
        title: `${product} ${u.displayVersion || u.version}`,
        required: !!u.isRequired,
        model: u.model,
        channel: u.channel || "production",
        notesUrl: `${getBaseUrl(req)}/api/release-notes?product=${encodeURIComponent(product)}&version=${encodeURIComponent(u.version)}${model ? `&model=${encodeURIComponent(model)}` : ""}${channel ? `&channel=${encodeURIComponent(channel)}` : ""}`,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return res.json({ product, model, channel, releases });
  } catch (e) {
    console.error("Error in /api/releases:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint: Desktop (new and legacy)
app.post("/desktop-update", async (req, res) => {
  const { channel } = req.body || {};
  await handleUpdateCheck(req, res, { product: "desktop", channel });
});


// Endpoint: Instrument (new and legacy)
app.post("/instrument-update", async (req, res) => {
  const { model, channel } = req.body || {};
  await handleUpdateCheck(req, res, { product: "instrument", model, channel });
});


// Endpoint: Recovery (new and legacy)
app.post("/recovery-update", async (req, res) => {
  const { channel } = req.body || {};
  await handleUpdateCheck(req, res, { product: "recovery", channel });
});


// Endpoint: Release notes (signed URL and/or inline), usable by apps and websites
app.get("/api/release-notes", async (req, res) => {
  try {
    const product = (req.query.product || "").toString();
    const version = req.query.version ? req.query.version.toString() : null;
    const model = req.query.model ? req.query.model.toString() : null;
    const channel = req.query.channel ? req.query.channel.toString() : "production";
    
    if (!product) {
      return res.status(400).json({ error: "Missing required query param: product" });
    }

    const manifest = await loadManifest();
    if (!manifest) {
      return res.status(404).json({ error: "Manifest not found" });
    }

    let candidates = (manifest.updates || []).filter((u) => u.product === product);
    
    // Filter by model for instrument products
    if (model && product === "instrument") {
      candidates = candidates.filter((u) => u.model === model);
    }
    
    // Filter by channel
    candidates = candidates.filter((u) => (u.channel || "production") === channel);
    
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
      version: entry.displayVersion || entry.version,
      model: entry.model,
      channel: entry.channel || "production",
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
async function handleUpdateCheck(req, res, { product, model, channel }) {
  const scenario = process.env.UPDATE_SCENARIO || req.query.scenario || "has_update";
  const { currentVersion, platform } = req.body || {};
  const targetChannel = channel || "production";

  try {
    if (scenario === "error") {
      return res.status(500).json({ error: "Update server temporarily unavailable" });
    }

    const manifest = await loadManifest();
    if (!manifest) {
      return res.status(404).json({ hasUpdate: false, currentVersion, message: "No manifest configured" });
    }

    let candidates = (manifest.updates || []).filter((u) => u.product === product);
    
    // Filter by model for instrument products
    if (model && product === "instrument") {
      candidates = candidates.filter((u) => u.model === model);
    }
    
    // Filter by channel (default to production)
    candidates = candidates.filter((u) => (u.channel || "production") === targetChannel);
    
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
    let notesEndpointUrl = `${getBaseUrl(req)}/api/release-notes?product=${encodeURIComponent(product)}&version=${encodeURIComponent(targetVersion)}`;
    if (model) notesEndpointUrl += `&model=${encodeURIComponent(model)}`;
    if (targetChannel !== "production") notesEndpointUrl += `&channel=${encodeURIComponent(targetChannel)}`;

      return res.json({
        hasUpdate: true,
        updateInfo: {
          version: targetVersion,
          displayVersion: entry.displayVersion || targetVersion,
          releaseNotes: releaseNotes?.content,
          releaseNotesUrl: notesEndpointUrl,
          isRequired,
          downloadUrl,
          model: entry.model,
          channel: entry.channel || "production",
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
      return `EasyMatch Quality Central-${version}-Setup.exe`;
    case "macos":
    case "darwin":
      return `EasyMatch Quality Central-${version}.pkg`;
    case "linux":
      return `EasyMatch Quality Central-${version}.AppImage`;
    default:
      return `EasyMatch Quality Central-${version}.zip`;
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
    if (entry.product === "instrument") {
      const defaultFile = entry.model ? `essentials-${entry.model.toLowerCase()}-update.hunterlab` : "essentials-update.hunterlab";
      return signBlobUrl(entry.file || defaultFile);
    }
    if (entry.product === "recovery") return signBlobUrl(entry.file || "essentials-recovery-update.hunterlab");
  }
  // If no Azure storage configured, honor explicit manifest URL if provided
  if (entry.downloadUrl) return entry.downloadUrl;
  // Local fallback
  if (entry.product === "desktop") return `/downloads/${getDesktopFileName(platform, !!entry.isRequired)}`;
  if (entry.product === "instrument") {
    const defaultFile = entry.model ? `essentials-${entry.model.toLowerCase()}-update.hunterlab` : "essentials-update.hunterlab";
    return `/downloads/${entry.file || defaultFile}`;
  }
  if (entry.product === "recovery") return `/downloads/${entry.file || "essentials-recovery-update.hunterlab"}`;
}

async function resolveReleaseNotes(entry) {
  // Handle simplified format where releaseNotes is just a string (blob name)
  const blobName = typeof entry.releaseNotes === 'string' 
    ? entry.releaseNotes 
    : entry.releaseNotes?.blob || entry.releaseNotesBlob;

  // If we have a blob name and storage, download and return inline
  if (storageAccount && blobName) {
    try {
      const content = await downloadBlobText(blobName);
      return { content };
    } catch (e) {
      console.warn("Failed to download release notes:", e.message);
      return null;
    }
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
      "GET /api/releases?product=...&model=...&channel=...",
      "GET /api/release-notes?product=...&version=...&model=...&channel=...",
      "POST /desktop-update (body: { currentVersion, platform, channel? })",
      "POST /instrument-update (body: { currentVersion, platform, model?, channel? })",
      "POST /recovery-update (body: { currentVersion, platform, channel? })",
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


