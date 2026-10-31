// Server for IPTV Stremio Addon (with debug + prefetch proxy to bypass browser CORS for pre-flight)
// Updated: Fixed prefetch stream handling (node-fetch readable stream -> chunk accumulation, no getReader()).
require('dotenv').config({ quiet: true });

const { getRouter } = require("stremio-addon-sdk");
const express = require("express");
const path = require("path");
const net = require("net");
const fetch = require("node-fetch");
const createAddon = require("./addon");
const { MAX_EPG_BYTES, parseEPGStream, getEPGStatus } = require("./src/js/epgStreamParser");
const { withTimeout } = require("./asyncUtils");
const { checkPersistence } = require("./storageStatus");
const setupAccess = require("./setupAccess");
const { isDebugEnabled, logAt } = require("./logger");
const { encryptConfig, tryParseConfigToken } = require("./cryptoConfig");
const { validateConfig } = require("./configValidation");
const LRUCache = require("./lruCache");
const requestContext = require("./requestContext");
const { projectResponse } = require("./publicMetadata");
const responseCompression = require("./responseCompression");
const fallbackLogo = require("./fallbackLogo");
const routerCache = new WeakMap();
const interfaceBuilds = new Map();
const MAX_LIVE_ADDON_INTERFACES = parseLiveLimit(process.env.MAX_LIVE_ADDON_INTERFACES);
function parseLiveLimit(value) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) && parsed >= 2 ? Math.min(32, parsed) : 6; }
let storageReady = !process.env.PERSISTENT_DATA_DIR && !process.env.CATALOG_META_CACHE_DIR && !process.env.SERIES_INFO_CACHE_DIR && !process.env.OMDB_API_KEY;
let stopping = false;
const storageReadyPromise = checkPersistence().then(status => {
  storageReady = true;
  logAt("info", "[STORAGE] Persistence check complete", status);
}).catch(error => {
  logAt("error", "[STORAGE] Configured storage is not writable", { errorName: error?.name || "Error", code: error?.code || "UNKNOWN" });
  setImmediate(() => shutdown("Storage initialization failed", true));
});

const DEBUG = isDebugEnabled();
function dlog(...args) {
  logAt("debug", "[DEBUG]", ...args);
}

const parsePositiveInteger = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= min
    ? Math.min(parsed, max)
    : fallback;
};

// Interfaces own scheduled refresh jobs; retain them until memory pressure evicts
// them, while the provider-data cache continues to use CACHE_TTL_MS.
const INTERFACE_TTL_MS = parsePositiveInteger(
  process.env.INTERFACE_CACHE_TTL_MS,
  0,
  0,
  30 * 24 * 3600 * 1000,
);
const INTERFACE_CACHE_MAX_BYTES = parsePositiveInteger(
  process.env.INTERFACE_CACHE_MAX_BYTES,
  256 * 1024 * 1024,
  16 * 1024 * 1024,
  4 * 1024 * 1024 * 1024,
);
const interfaceCache = new LRUCache({
  max: parsePositiveInteger(process.env.MAX_INTERFACE_CACHE_ENTRIES, 3, 1, 100),
  ttl: INTERFACE_TTL_MS,
  maxWeight: INTERFACE_CACHE_MAX_BYTES,
  sizeOf: (iface) => iface && Number.isFinite(iface.__cacheWeight) ? iface.__cacheWeight : 1,
  onEvict: (iface) => {
    createAddon.disposeAddonInterface(iface).catch((error) => {
      logAt("warn", "[CACHE] Could not dispose an evicted addon interface:", error?.name || "Error");
    });
  },
});
const MAX_ACTIVE_INTERFACE_BUILDS = parsePositiveInteger(
  process.env.MAX_ACTIVE_INTERFACE_BUILDS,
  2,
  1,
  8,
);
let activeInterfaceBuilds = 0;

const PREFETCH_MAX_BYTES_RAW = Number.parseInt(
  process.env.PREFETCH_MAX_BYTES || "50000000",
  10,
);
const PREFETCH_MAX_BYTES =
  Number.isSafeInteger(PREFETCH_MAX_BYTES_RAW) && PREFETCH_MAX_BYTES_RAW >= 1024
    ? Math.min(PREFETCH_MAX_BYTES_RAW, 150000000)
    : 150000000;
const PREFETCH_ENABLED =
  (process.env.PREFETCH_ENABLED || "true").toLowerCase() !== "false";
const MAX_ACTIVE_PREFETCHES = parsePositiveInteger(
  process.env.PREFETCH_MAX_CONCURRENT,
  2,
  1,
  8,
);
let activePrefetches = 0;

// The preflight endpoints are public and can trigger large upstream downloads.
// Apply a per-client rolling-window limit in addition to the existing global
// concurrency, timeout and byte limits. Keep this in memory (no new service).
const PREFLIGHT_RATE_WINDOW_MS = 60 * 1000;
const PREFLIGHT_RATE_MAX = parsePositiveInteger(
  process.env.PREFLIGHT_RATE_MAX,
  120,
  10,
  600,
);
const PREFLIGHT_RATE_MAX_CLIENTS = 5000;
const ADDON_REQUEST_RATE_MAX = parsePositiveInteger(process.env.ADDON_REQUEST_RATE_MAX, 1200, 60, 6000);
const addonRequestRateBuckets = new Map();
const preflightRateBuckets = new Map();

function getClientIp(req) {
  // Railway documents X-Real-IP as the edge-provided client address. Trust it
  // only on Railway and only when it parses as one IP; otherwise use Express
  // (including Render's explicitly trusted single proxy hop) or the socket.
  if (process.env.RAILWAY_SERVICE_ID) {
    const railwayIp = String(req.headers["x-real-ip"] || "").trim();
    if (net.isIP(railwayIp)) return railwayIp;
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function addonRequestRateLimit(req, res, next) {
  const now = Date.now();
  const key = getClientIp(req);
  let bucket = addonRequestRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= PREFLIGHT_RATE_WINDOW_MS) {
    if (!bucket && addonRequestRateBuckets.size >= PREFLIGHT_RATE_MAX_CLIENTS) {
      for (const [client, entry] of addonRequestRateBuckets) {
        if (now - entry.startedAt >= PREFLIGHT_RATE_WINDOW_MS) addonRequestRateBuckets.delete(client);
        if (addonRequestRateBuckets.size < PREFLIGHT_RATE_MAX_CLIENTS) break;
      }
      if (addonRequestRateBuckets.size >= PREFLIGHT_RATE_MAX_CLIENTS) {
        return res.status(503).json({ error: "Request rate-limit capacity reached; retry shortly" });
      }
    }
    bucket = { startedAt: now, count: 0 };
    addonRequestRateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > ADDON_REQUEST_RATE_MAX) {
    const retryAfter = Math.max(1, Math.ceil((PREFLIGHT_RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many addon requests; retry shortly" });
  }
  return next();
}
function preflightRateLimit(req, res, next) {
  const now = Date.now();
  const key = getClientIp(req);
  let bucket = preflightRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= PREFLIGHT_RATE_WINDOW_MS) {
    if (!bucket && preflightRateBuckets.size >= PREFLIGHT_RATE_MAX_CLIENTS) {
      for (const [client, entry] of preflightRateBuckets) {
        if (now - entry.startedAt >= PREFLIGHT_RATE_WINDOW_MS) {
          preflightRateBuckets.delete(client);
        }
        if (preflightRateBuckets.size < PREFLIGHT_RATE_MAX_CLIENTS) break;
      }
      if (preflightRateBuckets.size >= PREFLIGHT_RATE_MAX_CLIENTS) {
        return res.status(503).json({ error: "Preflight rate-limit capacity reached; retry shortly" });
      }
    }
    bucket = { startedAt: now, count: 0 };
    preflightRateBuckets.set(key, bucket);
  }
  bucket.count += 1;

  if (bucket.count > PREFLIGHT_RATE_MAX) {
    const retryAfter = Math.max(1, Math.ceil(
      (PREFLIGHT_RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000,
    ));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many preflight requests; retry shortly" });
  }
  return next();
}

const app = express();
// Render terminates TLS at its proxy; trust exactly that hop so per-client
// preflight limits use the originating client address rather than one shared proxy IP.
if (process.env.RENDER) app.set("trust proxy", 1);
const staticDir = path.join(__dirname, "src");
app.use((req, res, next) => {
  res.setHeader("X-App", "IPTV-Stremio-Addon");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'" +
    (req.path === "/support.html" ? " https://cdnjs.buymeacoffee.com" : "") +
    "; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https: http:; font-src 'self' data: https:; connect-src 'self' https: http:; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
  if (req.path !== "/health" && (!storageReady || stopping)) {
    res.setHeader("Retry-After", "5"); return res.status(503).json({ error: "Addon is starting or stopping; retry shortly" });
  }
  next();
});
app.use(setupAccess);
app.use(express.static(staticDir));
app.use(express.json({ limit: "128kb" }));
app.use(responseCompression);

// Encryption endpoint
app.post("/encrypt", preflightRateLimit, (req, res) => {
  if (!process.env.CONFIG_SECRET || process.env.CONFIG_SECRET.length < 16) {
    return res.status(503).json({
      error: "Secure token creation is unavailable. CONFIG_SECRET must be at least 16 characters.",
    });
  }
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Config payload must be a JSON object" });
  }
  try {
    const validatedConfig = validateConfig(req.body);
    const jsonStr = JSON.stringify(validatedConfig);
    const token = encryptConfig(jsonStr);
    if (!token) return res.status(500).json({ error: "Encrypt failed" });
    res.json({ token });
  } catch (error) {
    res.status(400).json({ error: "Invalid config payload", detail: DEBUG ? error.message : undefined });
  }
});

const { resolvePublicAddresses, createPinnedAgent, safeFetch } = require("./urlSafety");

// Count Xtream series from Railway without returning the full catalogue to the browser.
app.post("/api/xtream-series-check", preflightRateLimit, async (req, res) => {
  if (!PREFETCH_ENABLED) {
    return res.status(403).json({ ok: false, error: "Server preflight is disabled" });
  }
  if (activePrefetches >= MAX_ACTIVE_PREFETCHES) {
    res.setHeader("Retry-After", "5");
    return res.status(503).json({ ok: false, error: "Preflight capacity reached; retry shortly" });
  }

  let config;
  try {
    const input = req.body || {};
    config = validateConfig({
      provider: "xtream",
      xtreamUrl: input.xtreamUrl,
      xtreamUsername: input.xtreamUsername,
      xtreamPassword: input.xtreamPassword,
    });
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid Xtream connection settings" });
  }

  activePrefetches += 1;
  const startedAt = Date.now();
  try {
    const url = new URL(config.xtreamUrl.replace(/\/+$/, "") + "/player_api.php");
    url.searchParams.set("username", config.xtreamUsername);
    url.searchParams.set("password", config.xtreamPassword);
    url.searchParams.set("action", "get_series");

    const response = await safeFetch(url.toString(), {
      timeout: 35000,
      headers: { "User-Agent": "IPTV-Stremio-Addon series preflight/1.0" },
    });
    if (!response.ok) {
      if (response.body) response.body.destroy();
      return res.status(502).json({
        ok: false,
        error: "Xtream series API returned an HTTP error",
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
    }
    if (!response.body) {
      return res.status(502).json({
        ok: false,
        error: "Xtream series API returned an empty response",
        durationMs: Date.now() - startedAt,
      });
    }

    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > PREFETCH_MAX_BYTES) {
        response.body.destroy();
        return res.status(413).json({
          ok: false,
          error: "Xtream series response exceeds the server preflight size limit",
          bytes,
          durationMs: Date.now() - startedAt,
        });
      }
      chunks.push(chunk);
    }

    let series;
    try {
      const body = Buffer.concat(chunks, bytes).toString("utf8").replace(/^\uFEFF/, "");
      series = JSON.parse(body);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "Xtream series API returned invalid JSON",
        bytes,
        durationMs: Date.now() - startedAt,
      });
    }
    if (!Array.isArray(series)) {
      return res.status(502).json({
        ok: false,
        error: "Xtream series API response was not a list",
        bytes,
        durationMs: Date.now() - startedAt,
      });
    }

    res.json({
      ok: true,
      seriesCount: series.length,
      bytes,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const timedOut = /abort|timeout/i.test(String(error?.name || "")) ||
      /timed out/i.test(String(error?.message || ""));
    const code = typeof error?.code === "string" ? error.code.slice(0, 40) : null;
    res.status(502).json({
      ok: false,
      error: timedOut
        ? "Railway timed out while fetching Xtream series"
        : "Railway could not fetch Xtream series",
      code,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    activePrefetches = Math.max(0, activePrefetches - 1);
  }
});


// Stream-count XMLTV programmes without retaining the feed in memory.
app.post("/api/epg-stats", preflightRateLimit, async (req, res) => {
  if (!PREFETCH_ENABLED) {
    return res.status(403).json({ error: "Prefetch disabled by server" });
  }
  if (activePrefetches >= MAX_ACTIVE_PREFETCHES) {
    res.setHeader("Retry-After", "5");
    return res.status(503).json({ error: "EPG preflight capacity reached; retry shortly" });
  }
  const { url } = req.body || {};
  if (typeof url !== "string" || !url || url.length > 8192) {
    return res.status(400).json({ error: "A valid EPG URL is required" });
  }

  activePrefetches += 1;
  const controller = new AbortController();
  let totalBytes = 0;
  let programmeCount = 0;
  try {
    const response = await safeFetch(url, {
      method: "GET",
      timeout: 120000,
      signal: controller.signal,
      headers: { "User-Agent": "IPTV-Stremio-Addon EPG preflight/1.0" },
    });
    if (!response.ok) {
      if (response.body) response.body.destroy();
      return res.status(502).json({ error: "EPG source returned HTTP " + response.status });
    }
    if (!response.body) return res.status(502).json({ error: "EPG source returned an empty response" });

    const body = response.body;
    body.on("data", chunk => { totalBytes += chunk.length; });
    const parsed = await parseEPGStream(body, null, null, { countOnly: true });
    programmeCount = getEPGStatus(parsed).programmes;
    res.json({ ok: true, bytes: totalBytes, programmes: programmeCount });
  } catch (error) {
    const tooLarge = error && error.code === "EPG_TOO_LARGE";
    const timedOut = error && error.name === "AbortError";
    if (!res.headersSent) {
      res.status(tooLarge ? 413 : timedOut ? 504 : 502).json({
        error: tooLarge ? `EPG source exceeds the ${Math.floor(MAX_EPG_BYTES / 1000000)} MB preflight scan limit`
          : timedOut ? "EPG preflight timed out after 120 seconds"
          : "EPG source could not be checked",
      });
    }
  } finally {
    activePrefetches = Math.max(0, activePrefetches - 1);
  }
});


/**
 * Server-side prefetch for playlist / EPG pre-flight.
 * Every redirect is checked separately; the timeout covers DNS and body reads.
 */
app.post("/api/prefetch", preflightRateLimit, async (req, res) => {
  if (!PREFETCH_ENABLED) {
    return res.status(403).json({ error: "Prefetch disabled by server" });
  }

  const { url, purpose } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url" });
  }
  if (url.length > 8192) {
    return res.status(400).json({ error: "URL is too long" });
  }
  const safePurpose = typeof purpose === "string"
    ? purpose.slice(0, 80).replace(/[^a-zA-Z0-9 _.-]/g, "")
    : null;
  if (activePrefetches >= MAX_ACTIVE_PREFETCHES) {
    res.setHeader("Retry-After", "5");
    return res.status(503).json({ error: "Prefetch capacity reached; retry shortly" });
  }
  activePrefetches += 1;

  const controller = new AbortController();
  const agents = [];
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      const error = new Error("Prefetch timed out");
      error.name = "AbortError";
      reject(error);
    }, 45000);
  });

  try {
    let currentUrl;
    try {
      currentUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }


    const performFetch = async () => {
      let fetched;
      for (let redirects = 0; ; redirects++) {
        let addresses;
        let dnsTimer;
        try {
          addresses = await Promise.race([
            resolvePublicAddresses(currentUrl),
            new Promise((_, reject) => {
              dnsTimer = setTimeout(
                () => reject(new Error("URL DNS lookup timed out")),
                10000,
              );
            }),
          ]);
        } catch (error) {
          if (error.message === "Blocked host") {
            const blocked = new Error("Blocked host");
            blocked.statusCode = 400;
            throw blocked;
          }
          const invalid = new Error("Invalid or unsupported URL");
          invalid.statusCode = 400;
          throw invalid;
        } finally {
          clearTimeout(dnsTimer);
        }

        if (controller.signal.aborted) {
          const timeoutError = new Error("Prefetch timed out");
          timeoutError.name = "AbortError";
          throw timeoutError;
        }
        const agent = createPinnedAgent(currentUrl, addresses);
        agents.push(agent);
        fetched = await fetch(currentUrl.toString(), {
          method: "GET",
          signal: controller.signal,
          redirect: "manual",
          agent,
          headers: { "User-Agent": "IPTV-Stremio-Addon Prefetch/1.1" },
        });

        if (![301, 302, 303, 307, 308].includes(fetched.status)) break;
        const location = fetched.headers.get("location");
        if (!location) break;
        if (fetched.body) fetched.body.destroy();
        if (redirects >= 3) {
          const tooMany = new Error("Too many redirects");
          tooMany.statusCode = 502;
          throw tooMany;
        }
        try {
          currentUrl = new URL(location, currentUrl);
        } catch {
          const invalidRedirect = new Error("Invalid redirect URL");
          invalidRedirect.statusCode = 502;
          throw invalidRedirect;
        }
      }

      if (!fetched.ok) {
        if (fetched.body) fetched.body.destroy();
        const upstream = new Error("Upstream request failed");
        upstream.statusCode = 502;
        upstream.upstreamStatus = fetched.status;
        throw upstream;
    }
      const reader = fetched.body;
      if (!reader) throw new Error("Empty response body");
      const chunks = [];
      let received = 0;
      let truncated = false;

      await new Promise((resolve, reject) => {
        let ended = false;
        reader.on("data", (chunk) => {
          const remaining = Math.max(0, PREFETCH_MAX_BYTES - received);
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          received += chunk.length;
          if (received > PREFETCH_MAX_BYTES) {
            truncated = true;
            reader.destroy();
          }
        });
        reader.on("end", () => {
          ended = true;
          resolve();
        });
        reader.on("close", () => {
          if (ended || truncated) resolve();
          else reject(new Error("Response stream closed before completion"));
        });
        reader.on("error", (error) => {
          if (truncated) resolve();
          else reject(error);
        });
      });

      let content = Buffer.concat(chunks).toString("utf8");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

      return {
        ok: true,
        bytes: received,
        truncated,
        purpose: safePurpose,
        content,
      };
    };

    const result = await Promise.race([performFetch(), timeoutPromise]);
    clearTimeout(timeoutHandle);
    res.json(result);
  } catch (error) {
    dlog("Prefetch error", error && error.name ? error.name : "Error");
    if (!res.headersSent) {
      const status = error.statusCode || (
        error.name === "AbortError" || controller.signal.aborted ? 504 : 502
      );
      const response = {
        error: error.statusCode === 400
          ? error.message
          : error.statusCode === 502 && error.message === "Too many redirects"
            ? error.message
            : error.name === "AbortError" || controller.signal.aborted
              ? "Prefetch timed out"
              : "Prefetch error",
      };
      if (error.upstreamStatus) response.error = "Fetch failed (" + error.upstreamStatus + ")";
      if (DEBUG && status !== 400) response.detail = error.name || "Request failed";
      res.status(status).json(response);
    }
  } finally {
    clearTimeout(timeoutHandle);
    for (const agent of agents) agent.destroy();
    activePrefetches = Math.max(0, activePrefetches - 1);
  }
});

// Root & configuration pages
app.get("/", (req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.get("/health", (req, res) =>
  res.status(storageReady && !stopping ? 200 : 503).json({ status: storageReady && !stopping ? "OK" : "STARTING", timestamp: new Date().toISOString() }),
);
app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/configure-direct", (req, res) => res.sendFile(path.join(staticDir, "html", "direct-config.html")));
app.get("/configure-xtream", (req, res) => res.sendFile(path.join(staticDir, "html", "xtream-config.html")));

function maybeDecryptConfig(token) {
  return tryParseConfigToken(token);
}
function isConfigToken(token) {
  if (!token) return false;
  if (token.startsWith("enc:")) return true;
  if (token.length < 4) return false;
  return true;
}

// Legacy redirect
app.get("/:token/configure", (req, res) => {
  const { token } = req.params;
  if (!isConfigToken(token))
    return res.status(400).json({ error: "Invalid configuration" });
  let cfg;
  try {
    cfg = validateConfig(maybeDecryptConfig(token));
  } catch {
    return res.status(400).json({ error: "Invalid or unsupported configuration token" });
  }
  return res.redirect(`/${encodeURIComponent(token)}/configure-${cfg.provider}`);
});

app.get("/:token/configure-direct", (req, res) => {
  if (!isConfigToken(req.params.token))
    return res.status(400).json({ error: "Invalid token" });
  res.sendFile(path.join(staticDir, "html", "direct-config.html"));
});
app.get("/:token/configure-xtream", (req, res) => {
  if (!isConfigToken(req.params.token))
    return res.status(400).json({ error: "Invalid token" });
  res.sendFile(path.join(staticDir, "html", "xtream-config.html"));
});

// Return the saved config to its token-specific Configure page so settings can be edited.
// The encrypted token is a bearer secret; never request or log it separately.
app.get("/:token/configuration.json", (req, res) => {
  const token = req.params.token;
  if (!isConfigToken(token)) return res.status(400).json({ error: "Invalid token" });
  let config;
  try {
    config = validateConfig(maybeDecryptConfig(token));
  } catch {
    return res.status(400).json({ error: "Invalid configuration token" });
  }
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json(config);
});

// Token interface middleware
app.use("/:token", addonRequestRateLimit, async (req, res, next) => {
  const { token } = req.params;
  if (!isConfigToken(token)) return next("route");
  if (req.path.startsWith("/configure")) return next();

  let config;
  try {
    config = validateConfig(maybeDecryptConfig(token));
  } catch (e) {
    dlog("Config parse or validation failed", e.message);
    return res.status(400).json({ error: "Invalid configuration token" });
  }
  if (DEBUG && config.debug !== false) config.debug = true;

  const ifaceKey = createAddon.createInterfaceKey(config);

  let iface = interfaceCache.get(ifaceKey);
  let acquired = false;
  if (!iface) {
    let build = interfaceBuilds.get(ifaceKey);
    if (!build) {
      if (activeInterfaceBuilds >= MAX_ACTIVE_INTERFACE_BUILDS ||
          (createAddon.getActiveInterfaceCount?.() || 0) + activeInterfaceBuilds >= MAX_LIVE_ADDON_INTERFACES) {
        res.setHeader("Retry-After", "5");
        return res.status(503).json({ error: "Addon is busy building configurations; retry shortly" });
      }
      activeInterfaceBuilds++;
      build = Promise.resolve().then(() => createAddon(config)).finally(() => {
        activeInterfaceBuilds--;
        if (interfaceBuilds.get(ifaceKey) === build) interfaceBuilds.delete(ifaceKey);
      });
      interfaceBuilds.set(ifaceKey, build);
    }
    try { iface = await build; }
    catch (error) {
      logAt("error", "[SERVER] Addon build failed:", error?.name || "Error");
      return res.status(503).json({ error: "Addon build unavailable; retry shortly" });
    }
  }
  acquired = createAddon.acquireAddonInterface(iface);
  if (acquired) interfaceCache.set(ifaceKey, iface);

  if (!acquired) {
    res.setHeader("Retry-After", "1");
    return res.status(503).json({ error: "Addon interface is restarting; retry shortly" });
  }
  const controller = new AbortController();
  const userAgent = String(req.headers["user-agent"] || "").toLowerCase();
  let origin = "";
  try {
    const protocol = process.env.RAILWAY_SERVICE_ID || process.env.RENDER
      ? (req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol) : req.protocol;
    const candidate = new URL(protocol + "://" + req.get("host"));
    if (["http:", "https:"].includes(candidate.protocol) && !candidate.username && !candidate.password) origin = candidate.origin;
  } catch { /* Invalid origins use the absolute placeholder fallback. */ }
  req.loadingContext = { priority: "foreground", debug: config.debug === true, ios: userAgent.includes("stremio") && /iphone|ipad|ipod|ios/.test(userAgent),
    origin, token, signal: controller.signal, pending: new Set() };
  let released = false;
  const releaseInterface = () => {
    if (released) return;
    released = true;
    if (!res.writableFinished) controller.abort();
    const work = [...req.loadingContext.pending];
    if (work.length) Promise.allSettled(work).then(() => createAddon.releaseAddonInterface(iface));
    else createAddon.releaseAddonInterface(iface);
  };
  res.once("finish", releaseInterface);
  res.once("close", releaseInterface);
  if (res.destroyed) { releaseInterface(); return; }
  req.addonInterface = iface;
  req.configToken = token;
  next();
});

// Local fallback avoids external placeholder requests for channels without artwork.
app.get("/:token/logo/:tvgId.png", (req, res) => {
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=21600");
  res.end(fallbackLogo(req.params.tvgId));
});

// Serve manifest directly (bypasses SDK's 8KB-limited frozen manifest)
// This ensures Stremio always gets the full manifest with up-to-date genres.
app.get("/:token/manifest.json", (req, res) => {
  const iface = req.addonInterface;
  if (!iface) return res.status(500).json({ error: "Interface not ready" });

  // Build a full manifest from the interface's manifest (which has genres populated)
  const manifest = JSON.parse(JSON.stringify(iface.manifest));
  // Keep configurable enabled so Stremio can open /:token/configure.
  if (manifest.behaviorHints) delete manifest.behaviorHints.configurationRequired;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(manifest));
});

// Keep rendered card data fresh; internal/server caches do not require browser caching.
app.use("/:token", (req, res, next) => {
  if (/^\/(?:meta|catalog)\/(?:movie|series)\//.test(req.path)) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache"); res.setHeader("Expires", "0");
  }
  next();
});
// Stremio router (handles catalog, stream, meta)
app.use("/:token", (req, res) => {
  const iface = req.addonInterface;
  if (!iface) return res.status(500).json({ error: "Interface not ready" });

  let router = routerCache.get(iface);
  if (!router) {
    router = getRouter({ manifest: iface.manifest, get: (...args) => {
      const context = requestContext.current();
      const task = Promise.resolve().then(() => iface.get(...args))
        .then(body => projectResponse(body, context));
      context.pending?.add(task);
      task.then(() => context.pending?.delete(task), () => context.pending?.delete(task));
      return task;
    } });
    routerCache.set(iface, router);
  }
  requestContext.run(req.loadingContext, () => router(req, res, (err) => {
    if (err) {
      console.error("[SERVER] Router error:", err && err.name ? err.name : "Error");
      res.status(500).json({ error: "Addon error" });
    } else {
      res.status(404).json({ error: "Not found" });
    }
  }));
});

app.use("*", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((error, req, res, next) => {
  console.error("[SERVER] Unhandled error:", error && error.name ? error.name : "Error");
  if (!res.headersSent)
    res.status(500).json({ error: "Internal server error" });
});

const port = process.env.PORT || 7000;
const server = app.listen(port, () => {
  logAt("info", `🚀 Server running on port ${port} (debug=${DEBUG}, prefetch=${PREFETCH_ENABLED})`);
});

let shutdownPromise = null;
async function shutdown(signal, initialFailure = false) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  logAt("info", "[SHUTDOWN] Stopping requests and saving completed cache updates");
  const timeout = parsePositiveInteger(process.env.SHUTDOWN_TIMEOUT_MS, 15000, 1000, 60000);
  const finalSaveBudget = Math.min(2000, Math.max(100, Math.floor(timeout / 5)));
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  const closePromise = new Promise(resolve => server.close(resolve));
  shutdownPromise = (async () => {
    let failed = initialFailure;
    const interfaces = interfaceCache.entries().map(([, iface]) => iface);
    const drain = Promise.allSettled(interfaces.map(iface => createAddon.disposeAddonInterface(iface)))
      .then(async results => {
        await createAddon.flushAddonDisposals();
        if (results.some(result => result.status === "rejected")) throw new Error("Cache disposal failed");
      });
    try {
      await withTimeout(Promise.all([closePromise, drain]), Math.max(1, remaining() - finalSaveBudget), "Shutdown drain timed out");
    } catch (error) {
      failed = true;
      logAt("warn", "[SHUTDOWN] Work did not finish before the shutdown deadline", { code: error?.code || "UNKNOWN" });
    }
    server.closeAllConnections?.();
    try {
      const results = await withTimeout(createAddon.flushActiveAddonCaches?.() || Promise.resolve([]), remaining(), "Final cache flush timed out");
      if (results.some(result => result.status === "rejected")) throw new Error("Final cache flush failed");
      await withTimeout(createAddon.closeRedisClient(), remaining(), "Redis shutdown timed out");
    } catch (error) {
      failed = true;
      logAt("error", "[SHUTDOWN] Final cache save incomplete", { code: error?.code || "UNKNOWN" });
    }
    interfaceCache.clear();
    logAt(failed ? "warn" : "info", failed ? "[SHUTDOWN] Stopped with unfinished work" : "[SHUTDOWN] Persistent caches saved");
    process.exit(failed ? 1 : 0);
  })();
  return shutdownPromise;
}

process.once("SIGTERM", () => { shutdown("SIGTERM"); });
process.once("SIGINT", () => { shutdown("SIGINT"); });
