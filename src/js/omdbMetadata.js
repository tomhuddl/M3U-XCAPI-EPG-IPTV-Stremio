const { safeFetch } = require("../../urlSafety");
const LRUCache = require("../../lruCache");
const fs = require("fs");
const path = require("path");

const API_KEY = (process.env.OMDB_API_KEY || "").trim();
const CACHE_TTL_MS = parsePositiveInteger(process.env.OMDB_CACHE_TTL_MS, 14 * 24 * 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000);
const cache = new LRUCache({ max: parsePositiveInteger(process.env.OMDB_CACHE_MAX_ENTRIES, 2000, 50, 10000), ttl: CACHE_TTL_MS });
const pending = new Map();
const retryableFailures = new Map();
const DAILY_REQUEST_LIMIT = parsePositiveInteger(process.env.OMDB_DAILY_REQUEST_LIMIT, 100000, 1, 100000);
const DATA_DIR = process.env.PERSISTENT_DATA_DIR || path.join(process.cwd(), "data");
const USAGE_FILE = path.join(DATA_DIR, "omdb-usage.json");
let usageState = null;
let usageLoadPromise = null;
let usageWriteQueue = Promise.resolve();

async function loadUsageState() {
  if (usageState) return usageState;
  if (!usageLoadPromise) {
    usageLoadPromise = (async () => {
      try {
        const raw = await fs.promises.readFile(USAGE_FILE, "utf8");
        const saved = JSON.parse(raw);
        const today = new Date().toISOString().slice(0, 10);
        usageState = saved?.day === today && Number.isFinite(saved.count)
          ? { day: today, count: Math.max(0, Math.floor(saved.count)) }
          : { day: today, count: 0 };
      } catch {
        usageState = { day: new Date().toISOString().slice(0, 10), count: 0 };
      }
      return usageState;
    })();
  }
  return usageLoadPromise;
}

async function reserveDailyRequest() {
  const state = await loadUsageState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) {
    state.day = today;
    state.count = 0;
  }
  if (state.count >= DAILY_REQUEST_LIMIT) return false;
  state.count++;
  const snapshot = { day: state.day, count: state.count };
  let persisted = true;
  // Recover the queue after a previous write error, then retry this latest
  // snapshot. Never spend an OMDb request if the daily budget cannot be saved:
  // a restart must not reset the guard and accidentally exceed the daily limit.
  usageWriteQueue = usageWriteQueue.catch(() => {}).then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const temp = USAGE_FILE + ".tmp";
    await fs.promises.writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
    await fs.promises.rename(temp, USAGE_FILE);
  }).catch(error => {
    persisted = false;
    if ((process.env.DEBUG_MODE || "").toLowerCase() === "true") {
      console.warn("[DEBUG] Could not persist OMDb usage counter", error?.name || "Error");
    }
  });
  await usageWriteQueue;
  return persisted;
}

function parsePositiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= min ? Math.min(parsed, max) : fallback;
}

function validImdbId(value) {
  const id = String(value || "").trim();
  return /^tt\d{7,10}$/.test(id) ? id : null;
}

function parseRuntime(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/\b(\d{1,4})\s*min\b/i);
  return match ? Number(match[1]) : undefined;
}

async function getByImdbId(value) {
  const imdbId = validImdbId(value);
  if (!imdbId) return null;
  if (!API_KEY) {
    retryableFailures.set(imdbId, true);
    if ((process.env.DEBUG_MODE || "").toLowerCase() === "true") console.warn("[DEBUG] OMDb lookup skipped: OMDB_API_KEY is not available to this process");
    return null;
  }
  if (cache.has(imdbId)) {
    retryableFailures.delete(imdbId);
    return cache.get(imdbId);
  }
  if (pending.has(imdbId)) return pending.get(imdbId);

  const task = (async () => {
    retryableFailures.delete(imdbId);
    try {
      if (!(await reserveDailyRequest())) {
        retryableFailures.set(imdbId, true);
        if ((process.env.DEBUG_MODE || "").toLowerCase() === "true") console.warn("[DEBUG] OMDb daily request budget reached");
        return null;
      }
      const url = "https://www.omdbapi.com/?i=" + encodeURIComponent(imdbId) +
        "&apikey=" + encodeURIComponent(API_KEY);
      const response = await safeFetch(url, {
        timeout: 8000,
        reuseConnection: true,
        headers: { Accept: "application/json", "User-Agent": "M3U-XCAPI-EPG-IPTV-Stremio" }
      });
      if (!response || !response.ok) {
        retryableFailures.set(imdbId, true);
        return null;
      }
      const data = await response.json();
      if (!data || data.Response !== "True") {
        // A missing title or invalid key is not helped by repeatedly retrying
        // every hour; quota and temporary service errors should be retried.
        const errorText = String(data?.Error || "").toLowerCase();
        const retryable = /request limit|too many requests|temporarily unavailable|timeout|server error|invalid api key|api key/.test(errorText);
        retryableFailures.set(imdbId, retryable);
        if (retryable) return null;
        const result = { imdbId, omdbChecked: true };
        cache.set(imdbId, result);
        return result;
      }
      const ratingValue = Number(data.imdbRating);
      const result = {
        imdbId: validImdbId(data.imdbID) || imdbId,
        omdbChecked: true,
        imdbRating: Number.isFinite(ratingValue) && ratingValue >= 0 && ratingValue <= 10
          ? ratingValue.toFixed(1) : undefined,
        runtimeMinutes: parseRuntime(data.Runtime),
        runtime: parseRuntime(data.Runtime) ? parseRuntime(data.Runtime) + " min" : undefined,
      };
      cache.set(imdbId, result);
      retryableFailures.delete(imdbId);
      return result;
    } catch (error) {
      retryableFailures.set(imdbId, true);
      // OMDb is optional: a transient outage must never break card delivery.
      if ((process.env.DEBUG_MODE || "").toLowerCase() === "true") {
        console.warn("[DEBUG] OMDb lookup failed", { imdbId, name: error?.name || "Error" });
      }
      return null;
    }
  })();
  pending.set(imdbId, task);
  try {
    return await task;
  } finally {
    if (pending.get(imdbId) === task) pending.delete(imdbId);
  }
}

function shouldRetryLookup(value) {
  const imdbId = validImdbId(value);
  return Boolean(imdbId && retryableFailures.get(imdbId));
}

module.exports = { getByImdbId, validImdbId, shouldRetryLookup };
