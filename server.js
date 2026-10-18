// Server for IPTV Stremio Addon (with debug + prefetch proxy to bypass browser CORS for pre-flight)
// Updated: Fixed prefetch stream handling (node-fetch readable stream -> chunk accumulation, no getReader()).
require("dotenv").config();

const { getRouter } = require("stremio-addon-sdk");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fetch = require("node-fetch");
const createAddon = require("./addon");
const { encryptConfig, tryParseConfigToken } = require("./cryptoConfig");
const { validateConfig } = require("./configValidation");
const LRUCache = require("./lruCache");

const DEBUG = (process.env.DEBUG_MODE || "").toLowerCase() === "true";
function dlog(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

const CACHE_ENABLED =
  (process.env.CACHE_ENABLED || "true").toLowerCase() !== "false";

const parsePositiveInteger = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= min
    ? Math.min(parsed, max)
    : fallback;
};

const INTERFACE_TTL_MS = parsePositiveInteger(
  process.env.CACHE_TTL_MS,
  6 * 3600 * 1000,
  1000,
  30 * 24 * 3600 * 1000,
);
const interfaceCache = new LRUCache({
  max: parsePositiveInteger(process.env.MAX_CACHE_ENTRIES, 100, 1, 500),
  ttl: INTERFACE_TTL_MS,
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

const app = express();
const staticDir = path.join(__dirname, "src");
app.use((req, res, next) => {
  res.setHeader("X-App", "IPTV-Stremio-Addon");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.static(staticDir));
app.use(express.json({ limit: "128kb" }));

// Encryption endpoint
app.post("/encrypt", (req, res) => {
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

// Stream-count XMLTV programmes without retaining the feed in memory.
app.post("/api/epg-stats", async (req, res) => {
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
  let tail = "";
  const MAX_EPG_SCAN_BYTES = 800 * 1024 * 1024;
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
    const countTags = (text, cutoff) => {
      const re = /<programme(?:\s|>)/gi;
      let match;
      while ((match = re.exec(text)) !== null) {
        if (match.index >= cutoff) break;
        programmeCount++;
      }
    };

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };
      body.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_EPG_SCAN_BYTES) {
          controller.abort();
          body.destroy();
          finish(new Error("EPG source exceeds the 800 MB preflight scan limit"));
          return;
        }
        const combined = tail + chunk.toString("utf8");
        const cutoff = Math.max(0, combined.length - 40);
        countTags(combined, cutoff);
        tail = combined.slice(cutoff);
      });
      body.on("end", () => {
        countTags(tail, tail.length + 1);
        finish();
      });
      body.on("error", (error) => finish(error));
      body.on("close", () => {
        if (!settled) finish(new Error("EPG response closed before completion"));
      });
    });

    res.json({ ok: true, bytes: totalBytes, programmes: programmeCount });
  } catch (error) {
    const tooLarge = error && /800 MB/.test(error.message || "");
    const timedOut = error && error.name === "AbortError";
    if (!res.headersSent) {
      res.status(tooLarge ? 413 : timedOut ? 504 : 502).json({
        error: tooLarge ? "EPG source exceeds the 800 MB preflight scan limit"
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
app.post("/api/prefetch", async (req, res) => {
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

    dlog("Prefetch start", { purpose: safePurpose });

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

      dlog("Prefetch done", {
        bytes: received,
        truncated,
        returnedBytes: Buffer.byteLength(content),
      });

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
  res.json({ status: "OK", timestamp: new Date().toISOString() }),
);
app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/configure-direct", (req, res) => {
  const fileRoot = path.join(__dirname, "direct-config.html");
  res.sendFile(fileRoot, (err) => {
    if (err) res.sendFile(path.join(staticDir, "html", "direct-config.html"));
  });
});
app.get("/configure-xtream", (req, res) => {
  const fileRoot = path.join(__dirname, "xtream-config.html");
  res.sendFile(fileRoot, (err) => {
    if (err) res.sendFile(path.join(staticDir, "html", "xtream-config.html"));
  });
});

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
  const fileRoot = path.join(__dirname, "direct-config.html");
  res.sendFile(fileRoot, (err) => {
    if (err) res.sendFile(path.join(staticDir, "html", "direct-config.html"));
  });
});
app.get("/:token/configure-xtream", (req, res) => {
  if (!isConfigToken(req.params.token))
    return res.status(400).json({ error: "Invalid token" });
  const fileRoot = path.join(__dirname, "xtream-config.html");
  res.sendFile(fileRoot, (err) => {
    if (err) res.sendFile(path.join(staticDir, "html", "xtream-config.html"));
  });
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
app.use("/:token", async (req, res, next) => {
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

  const ifaceKey =
    "iface:" + crypto.createHash("sha256").update(token).digest("hex");

  let iface = CACHE_ENABLED ? interfaceCache.get(ifaceKey) : null;
  if (!iface) {
    if (activeInterfaceBuilds >= MAX_ACTIVE_INTERFACE_BUILDS) {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ error: "Addon is busy building configurations; retry shortly" });
    }
    activeInterfaceBuilds += 1;
    try {
      dlog("Building addon interface (cache miss)");
      iface = await createAddon(config);
      if (CACHE_ENABLED) interfaceCache.set(ifaceKey, iface);
    } catch (e) {
      // Provider errors can include request URLs; don't log them with credentials.
      console.error("[SERVER] Addon build failed:", e && e.name ? e.name : "Error");
      return res.status(500).json({ error: "Addon build error" });
    } finally {
      activeInterfaceBuilds = Math.max(0, activeInterfaceBuilds - 1);
    }
  } else {
    dlog("Interface cache hit");
  }

  req.addonInterface = iface;
  req.configToken = token;
  dlog("Addon request", req.method, req.path);
  next();
});

// Logo proxy
app.get("/:token/logo/:tvgId.png", async (req, res) => {
  if (!req.addonInterface) {
    return res.redirect(
      `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(req.params.tvgId)}`,
    );
  }
  const sources = req.addonInterface._logoSources || [];
  if (!sources.length) {
    return res.redirect(
      `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(req.params.tvgId)}`,
    );
  }
  const { tvgId } = req.params;
  const rawId = tvgId;
  const noCountry = rawId.replace(/\.[a-z]{2,3}$/, "");
  const hyphenated = noCountry.replace(/[^a-zA-Z0-9]+/g, "-");
  const underscored = noCountry.replace(/[^a-zA-Z0-9]+/g, "_");
  const candidates = [...new Set([rawId, noCountry, hyphenated, underscored])];
  for (const cand of candidates) {
    for (const template of sources) {
      const url = template.replace("{id}", cand);
      try {
        const image = await safeFetch(url, {
          method: "GET",
          timeout: 10000,
          size: 5 * 1024 * 1024,
        });
        if (!image.ok) {
          if (image.body) image.body.destroy();
          continue;
        }
        const contentType = image.headers.get("content-type") || "";
        if (!contentType.toLowerCase().startsWith("image/")) {
          if (image.body) image.body.destroy();
          continue;
        }
        const buffer = await image.buffer();
        if (buffer.length > 50) {
          res.setHeader("Content-Type", contentType);
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "public, max-age=21600");
          return res.end(buffer);
        }
      } catch {
        /* Try another candidate. */
      }
    }
  }
  res.redirect(
    `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(noCountry.toUpperCase().slice(0, 12))}`,
  );
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

// Stremio router (handles catalog, stream, meta)
app.use("/:token", (req, res) => {
  const iface = req.addonInterface;
  if (!iface) return res.status(500).json({ error: "Interface not ready" });

  const router = getRouter(iface);
  router(req, res, (err) => {
    if (err) {
      console.error("[SERVER] Router error:", err && err.name ? err.name : "Error");
      res.status(500).json({ error: "Addon error" });
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });
});

app.use("*", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((error, req, res, next) => {
  console.error("[SERVER] Unhandled error:", error && error.name ? error.name : "Error");
  if (!res.headersSent)
    res.status(500).json({ error: "Internal server error" });
});

const port = process.env.PORT || 7000;
app.listen(port, () => {
  console.log(
    `🚀 Server running on port ${port} (debug=${DEBUG}, prefetch=${PREFETCH_ENABLED})`,
  );
});
