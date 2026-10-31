"use strict";

const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const net = require("net");
const ipaddr = require("ipaddr.js");
const fetch = require("node-fetch");
const RequestScheduler = require("./requestScheduler");
const requestContext = require("./requestContext");
const scheduler = new RequestScheduler();

const REUSABLE_AGENT_MAX_ENTRIES = 8;
const reusableAgents = new Map();
// Coalesce simultaneous DNS lookups for the same hostname without caching
// answers across requests. Each request still validates the returned addresses.
const pendingDnsLookups = new Map();

function lookupAllAddresses(hostname) {
  if (pendingDnsLookups.has(hostname)) return pendingDnsLookups.get(hostname);
  const lookup = dns.lookup(hostname, { all: true, verbatim: true })
    .finally(() => pendingDnsLookups.delete(hostname));
  pendingDnsLookups.set(hostname, lookup);
  return lookup;
}

const PROVIDER_MAX_BYTES_RAW = Number.parseInt(
  process.env.PROVIDER_MAX_BYTES || "50000000",
  10,
);
const PROVIDER_MAX_BYTES =
  Number.isSafeInteger(PROVIDER_MAX_BYTES_RAW) && PROVIDER_MAX_BYTES_RAW >= 1024
    ? Math.min(PROVIDER_MAX_BYTES_RAW, 150000000)
    : 50000000;

// Reject non-public destinations before server-side requests. The HTTP(S) agent
// pins DNS lookups to the validated addresses to reduce DNS-rebinding risk.
function isPublicAddress(address) {
  try {
    // ipaddr.js classifies special-use ranges (private, loopback, link-local,
    // documentation, multicast, mapped IPv4, 6to4, Teredo, etc.) consistently.
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

async function resolvePublicAddresses(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const lowerHost = hostname.toLowerCase();
  if (
    !hostname ||
    lowerHost === "localhost" ||
    lowerHost.endsWith(".localhost") ||
    lowerHost.endsWith(".local") ||
    lowerHost.endsWith(".internal")
  ) throw new Error("Blocked host");

  const family = net.isIP(hostname);
  const records = family
    ? [{ address: hostname, family }]
    : await lookupAllAddresses(hostname);

  if (!records.length || records.some((record) => !isPublicAddress(record.address))) {
    throw new Error("Blocked host");
  }
  return records;
}

function createPinnedAgent(url, addresses, keepAlive = false) {
  const lookup = (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const records = addresses.map(({ address, family }) => ({ address, family }));
    const matching = options && options.family
      ? records.filter((record) => record.family === options.family)
      : records;
    if (!matching.length) {
      callback(new Error("No validated address for requested IP family"));
      return;
    }
    if (options && options.all) {
      callback(null, matching);
      return;
    }
    callback(null, matching[0].address, matching[0].family);
  };

  return url.protocol === "https:"
    ? new https.Agent({ keepAlive, maxSockets: 16, maxFreeSockets: 4, lookup })
    : new http.Agent({ keepAlive, maxSockets: 16, maxFreeSockets: 4, lookup });
}

function getPinnedAgent(url, addresses, reuseConnection) {
  if (!reuseConnection) return createPinnedAgent(url, addresses);
  // DNS is still resolved and validated on every request. Including the exact
  // validated address set in the key prevents reusing an agent pinned to an
  // address that is no longer returned by DNS.
  const addressKey = addresses
    .map(({ address, family }) => family + ":" + address)
    .sort()
    .join(",");
  const key = url.protocol + "//" + url.hostname.toLowerCase() + ":" +
    (url.port || (url.protocol === "https:" ? "443" : "80")) + "|" + addressKey;
  let agent = reusableAgents.get(key);
  if (agent && !agent.destroyed) {
    reusableAgents.delete(key);
    reusableAgents.set(key, agent);
    return agent;
  }
  agent = createPinnedAgent(url, addresses, true);
  reusableAgents.set(key, agent);
  while (reusableAgents.size > REUSABLE_AGENT_MAX_ENTRIES) {
    const oldestKey = reusableAgents.keys().next().value;
    const oldestAgent = reusableAgents.get(oldestKey);
    reusableAgents.delete(oldestKey);
    oldestAgent?.destroy();
  }
  return agent;
}

/**
 * Fetch only from public HTTP(S) destinations and validate every redirect.
 * Caller-supplied node-fetch options (timeout, signal, headers, etc.) are kept,
 * but redirect handling and the DNS-pinned agent are controlled here.
 */
async function safeFetchUnscheduled(input, options = {}) {
  let currentUrl;
  try {
    currentUrl = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new Error("Invalid URL");
  }

  const maxRedirects = Number.isInteger(options.maxRedirects)
    ? Math.max(0, Math.min(options.maxRedirects, 5))
    : 3;
  const fetchOptions = { ...options };
  const reuseConnection = fetchOptions.reuseConnection === true;
  const diagnostics = fetchOptions.diagnostics && typeof fetchOptions.diagnostics === "object"
    ? fetchOptions.diagnostics
    : ((process.env.DEBUG_MODE || "").toLowerCase() === "true" &&
       currentUrl.hostname.toLowerCase() === "api.themoviedb.org" ? {} : null);
  delete fetchOptions.diagnostics;
  delete fetchOptions.reuseConnection;
  delete fetchOptions.maxRedirects;

  // Keep a total deadline active through response-body consumption. node-fetch's
  // timeout option alone is an inactivity timeout, not a strict overall deadline.
  const externalSignal = fetchOptions.signal;
  const timeoutMs = Number.isFinite(fetchOptions.timeout) && fetchOptions.timeout > 0
    ? Math.min(fetchOptions.timeout, 120000)
    : 45000;
  const controller = new AbortController();
  delete fetchOptions.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = (agent) => {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    if (agent && !reuseConnection) agent.destroy();
  };

  // node-fetch v2 otherwise permits unbounded response bodies. Clamp caller
  // limits to 150 MB so a malformed provider response cannot exhaust memory.
  const requestedSize = Number.isSafeInteger(fetchOptions.size) && fetchOptions.size > 0
    ? fetchOptions.size
    : PROVIDER_MAX_BYTES;
  fetchOptions.size = Math.min(requestedSize, 150000000);
  fetchOptions.signal = controller.signal;
  fetchOptions.redirect = "manual";

  let finalAgent = null;
  try {
    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) {
        const error = new Error("Request aborted or timed out");
        error.name = "AbortError";
        throw error;
      }

      let dnsTimer;
      let records;
      const dnsStartedAt = Date.now();
      try {
        records = await Promise.race([
          resolvePublicAddresses(currentUrl),
          new Promise((_, reject) => {
            dnsTimer = setTimeout(
              () => reject(new Error("URL DNS lookup timed out")),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(dnsTimer);
        if (diagnostics) {
          diagnostics.dnsMs = (diagnostics.dnsMs || 0) + Date.now() - dnsStartedAt;
        }
      }

      if (controller.signal.aborted) {
        const error = new Error("Request aborted or timed out");
        error.name = "AbortError";
        throw error;
      }

      const agent = getPinnedAgent(currentUrl, records, reuseConnection);
      if (diagnostics) {
        // Reports idle socket availability, not guaranteed socket selection.
        diagnostics.freeSocketsBeforeRequest = Object.values(agent.freeSockets || {})
          .reduce((total, sockets) => total + sockets.length, 0);
      }
      let response;
      const headersStartedAt = Date.now();
      try {
        response = await fetch(currentUrl.toString(), {
          ...fetchOptions,
          agent,
          redirect: "manual",
        });
      } catch (error) {
        if (!reuseConnection) agent.destroy();
        throw error;
      }

      if (diagnostics) {
        diagnostics.headersMs = Date.now() - headersStartedAt;
      }

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        finalAgent = agent;
        if (response.body) {
          const close = () => cleanup(finalAgent);
          response.body.once("end", close);
          response.body.once("error", close);
          response.body.once("close", close);
        } else {
          cleanup(finalAgent);
        }
        return response;
      }

      const location = response.headers.get("location");
      if (!location) {
        finalAgent = agent;
        if (response.body) {
          const close = () => cleanup(finalAgent);
          response.body.once("end", close);
          response.body.once("error", close);
          response.body.once("close", close);
        } else {
          cleanup(finalAgent);
        }
        return response;
      }

      if (response.body) response.body.destroy();
      if (!reuseConnection) agent.destroy();
      if (redirects >= maxRedirects) {
        throw new Error("Too many redirects");
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new Error("Invalid redirect URL");
      }
    }
  } catch (error) {
    cleanup(finalAgent);
    throw error;
  }
}

async function safeFetch(input, options = {}) {
  const origin = new URL(input).origin;
  const release = await scheduler.acquire(origin, requestContext.current().priority);
  try {
    const response = await safeFetchUnscheduled(input, options);
    if (response.body?.once) {
      response.body.once("end", release); response.body.once("close", release); response.body.once("error", release);
      if (response.body.readableEnded || response.body.destroyed) release();
    } else release();
    return response;
  } catch (error) { release(); throw error; }
}

module.exports = {
  isPublicAddress,
  resolvePublicAddresses,
  createPinnedAgent,
  getPinnedAgent,
  safeFetch,
};
