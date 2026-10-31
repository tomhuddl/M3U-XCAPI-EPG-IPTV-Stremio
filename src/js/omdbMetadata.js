const { safeFetch } = require("../../urlSafety");
const LRUCache = require("../../lruCache");
const fs = require("fs");
const path = require("path");
const API_KEY = (process.env.OMDB_API_KEY || "").trim();
const CACHE_TTL_MS = parsePositiveInteger(process.env.OMDB_CACHE_TTL_MS, 14 * 24 * 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000);
const cache = new LRUCache({ max: parsePositiveInteger(process.env.OMDB_CACHE_MAX_ENTRIES, 2000, 50, 10000), ttl: CACHE_TTL_MS });
const pending = new Map();
const retryableFailures = new Map();
const RETRY_FAILURE_MAX_ENTRIES = parsePositiveInteger(process.env.OMDB_RETRY_FAILURE_MAX_ENTRIES, 10000, 100, 100000);
const DAILY_REQUEST_LIMIT = parsePositiveInteger(process.env.OMDB_DAILY_REQUEST_LIMIT, 100000, 1, 100000);
const DAILY_RESERVATION_BLOCK_SIZE = parsePositiveInteger(
  process.env.OMDB_DAILY_RESERVATION_BLOCK_SIZE, 25, 1, 1000
);
const DATA_DIR = process.env.PERSISTENT_DATA_DIR || path.join(process.cwd(), "data");
const USAGE_FILE = path.join(DATA_DIR, "omdb-usage.json");
let usageState = null;
let usageLoadPromise = null;
let reservedRequestsRemaining = 0;
let usageReservationPromise = null;
const diagnostics = {
  apiKeyConfigured: Boolean(API_KEY),
  attempts: 0,
  successWithRating: 0,
  successWithoutRating: 0,
  retryableFailures: 0,
  definitiveNoMatch: 0,
  skippedInvalidImdbId: 0,
  lastOutcome: "not-started"
};
function recordOutcome(outcome) {
  diagnostics.lastOutcome = outcome;
  if (outcome === "success-with-rating") diagnostics.successWithRating++;
  else if (outcome === "success-without-rating") diagnostics.successWithoutRating++;
  else if (outcome === "retryable-failure") diagnostics.retryableFailures++;
  else if (outcome === "definitive-no-match") diagnostics.definitiveNoMatch++;
}

function markRetryableFailure(imdbId, retryable = true) {
  if (!retryable) {
    retryableFailures.delete(imdbId);
    return;
  }
  retryableFailures.delete(imdbId);
  if (retryableFailures.size >= RETRY_FAILURE_MAX_ENTRIES) {
    retryableFailures.delete(retryableFailures.keys().next().value);
  }
  retryableFailures.set(imdbId, true);
}
function getDiagnostics() {
  return { ...diagnostics };
}

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
  // Serialize rollover, reservation and consumption, not only the disk write.
  // Otherwise a reservation from yesterday can overwrite today's shared state.
  const reservation = Promise.resolve(usageReservationPromise).catch(() => {}).then(async () => {
    const state = await loadUsageState();
    while (true) {
      const today = new Date().toISOString().slice(0, 10);
      if (state.day !== today) {
        state.day = today;
        state.count = 0;
        reservedRequestsRemaining = 0;
      }
      if (reservedRequestsRemaining > 0) { reservedRequestsRemaining--; return true; }
      if (state.count >= DAILY_REQUEST_LIMIT) return false;
      const grant = Math.min(DAILY_RESERVATION_BLOCK_SIZE, DAILY_REQUEST_LIMIT - state.count);
      const snapshot = { day: today, count: state.count + grant };
      const temp = USAGE_FILE + "." + process.pid + ".tmp";
      try {
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
        await fs.promises.writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
        await fs.promises.rename(temp, USAGE_FILE);
      } catch { return false; }
      finally { await fs.promises.unlink(temp).catch(() => {}); }
      if (new Date().toISOString().slice(0, 10) !== today) continue;
      state.count = snapshot.count;
      reservedRequestsRemaining = grant - 1;
      return true;
    }
  });
  usageReservationPromise = reservation;
  try {
    return await reservation;
  } finally {
    if (usageReservationPromise === reservation) usageReservationPromise = null;
  }
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

function retryableResult(imdbId, previous = null) {
  return {
    ...(previous || {}),
    imdbId,
    // Record failed attempts so the caller's 12-hour policy can throttle retries.
    omdbCheckedAt: Date.now(),
    omdbRetryableFailure: true
  };
}

async function getByImdbId(value, options = {}) {
  const imdbId = validImdbId(value);
  if (!imdbId) {
    diagnostics.skippedInvalidImdbId++;
    return null;
  }
  if (!API_KEY) {
    markRetryableFailure(imdbId, true);
    recordOutcome("retryable-failure", { reason: "api-key-unavailable" });
    return retryableResult(imdbId, cache.get(imdbId) || null);
  }
  let staleCached = null;
  if (cache.has(imdbId)) {
    const cached = cache.get(imdbId);
    const refreshIncomplete = options.refreshIncomplete === true &&
      cached && (!cached.imdbRating || !cached.runtime);
    if (options.refresh !== true && !refreshIncomplete) {
      retryableFailures.delete(imdbId);
      return cached;
    }
    // Keep the previous response while refreshing an incomplete one. If the
    // request fails, callers can still use the last known rating/runtime.
    staleCached = cached;
  }
  if (pending.has(imdbId)) return pending.get(imdbId);

  const task = (async () => {
    retryableFailures.delete(imdbId);
    try {
      if (!(await reserveDailyRequest())) {
        markRetryableFailure(imdbId, true);
        return retryableResult(imdbId, staleCached);
      }
      const url = "https://www.omdbapi.com/?i=" + encodeURIComponent(imdbId) +
        "&apikey=" + encodeURIComponent(API_KEY);
      diagnostics.attempts++;
      const response = await safeFetch(url, {
        timeout: 8000,
        reuseConnection: true,
        headers: { Accept: "application/json", "User-Agent": "M3U-XCAPI-EPG-IPTV-Stremio" }
      });
      if (!response || !response.ok) {
        response?.body?.destroy?.();
        markRetryableFailure(imdbId, true);
        recordOutcome("retryable-failure", { httpOk: Boolean(response?.ok) });
        return retryableResult(imdbId, staleCached);
      }
      const data = await response.json();
      if (!data || data.Response !== "True") {
        // A missing title or invalid key is not helped by repeatedly retrying
        // every hour; quota and temporary service errors should be retried.
        const errorText = String(data?.Error || "").toLowerCase();
        const retryable = /request limit|too many requests|temporarily unavailable|timeout|server error|invalid api key|api key/.test(errorText);
        markRetryableFailure(imdbId, retryable);
        if (retryable) {
          recordOutcome("retryable-failure", { response: "not-true" });
          return retryableResult(imdbId, staleCached);
        }
        const result = {
          ...(staleCached || {}),
          imdbId,
          omdbChecked: true,
          omdbCheckedAt: Date.now()
        };
        cache.set(imdbId, result);
        recordOutcome("definitive-no-match");
        return result;
      }
      const ratingValue = data.imdbRating != null && String(data.imdbRating).trim() !== ""
        ? Number(data.imdbRating) : NaN;
      const freshResult = {
        imdbId: validImdbId(data.imdbID) || imdbId,
        omdbChecked: true,
        omdbCheckedAt: Date.now(),
        imdbRating: Number.isFinite(ratingValue) && ratingValue >= 0 && ratingValue <= 10
          ? ratingValue.toFixed(1) : undefined,
        runtimeMinutes: parseRuntime(data.Runtime),
        runtime: parseRuntime(data.Runtime) ? parseRuntime(data.Runtime) + " min" : undefined,
      };
      // OMDb can return a valid response with one field missing. Keep any
      // previously known rating/runtime rather than replacing it with blanks.
      const result = {
        ...staleCached,
        ...freshResult,
        imdbRating: freshResult.imdbRating || staleCached?.imdbRating,
        runtime: freshResult.runtime || staleCached?.runtime,
        runtimeMinutes: freshResult.runtimeMinutes || staleCached?.runtimeMinutes
      };
      cache.set(imdbId, result);
      retryableFailures.delete(imdbId);
      recordOutcome(result.imdbRating ? "success-with-rating" : "success-without-rating");
      return result;
    } catch (error) {
      markRetryableFailure(imdbId, true);
      recordOutcome("retryable-failure", { error: error?.name || "Error" });
      // OMDb is optional: a transient outage must never break card delivery.
      return retryableResult(imdbId, staleCached);
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

module.exports = { getByImdbId, validImdbId, shouldRetryLookup, getDiagnostics };
