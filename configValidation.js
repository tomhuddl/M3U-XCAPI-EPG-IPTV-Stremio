"use strict";

const MAX_URL_LENGTH = 8192;
const MAX_EPG_SOURCES = 20;

function requireString(value, field, { required = false, maxLength = 4096 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`Missing ${field}`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function validateHttpUrl(value, field, { required = false } = {}) {
  const raw = requireString(value, field, { required, maxLength: MAX_URL_LENGTH });
  if (raw === undefined) return undefined;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ${field}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`Invalid ${field}: HTTP(S) URLs are required`);
  }
  return raw;
}

function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Configuration must be a JSON object");
  }

  const provider = input.provider || (input.useXtream ? "xtream" : "direct");
  if (provider !== "direct" && provider !== "xtream") {
    throw new Error("Unsupported provider");
  }

  const config = { provider };
  if (provider === "direct") {
    config.m3uUrl = validateHttpUrl(input.m3uUrl, "m3uUrl", { required: true });
  } else {
    config.xtreamUrl = validateHttpUrl(input.xtreamUrl, "xtreamUrl", { required: true });
    const parsed = new URL(config.xtreamUrl);
    if (parsed.search || parsed.hash) {
      throw new Error("xtreamUrl must be a base URL without a query or fragment");
    }
    config.xtreamUrl = config.xtreamUrl.replace(/\/+$/, "");
    config.xtreamUsername = requireString(input.xtreamUsername, "xtreamUsername", {
      required: true,
      maxLength: 256,
    });
    config.xtreamPassword = requireString(input.xtreamPassword, "xtreamPassword", {
      required: true,
      maxLength: 1024,
    });
    if (input.xtreamUseM3U !== undefined && typeof input.xtreamUseM3U !== "boolean") {
      throw new Error("Invalid xtreamUseM3U");
    }
    if (input.xtreamUseM3U) config.xtreamUseM3U = true;
    const output = requireString(input.xtreamOutput, "xtreamOutput", { maxLength: 32 });
    if (output !== undefined) config.xtreamOutput = output;
  }

  const epgUrl = validateHttpUrl(input.epgUrl, "epgUrl");
  if (epgUrl !== undefined && epgUrl.trim()) config.epgUrl = epgUrl.trim();

  if (input.epgUrls !== undefined) {
    if (!Array.isArray(input.epgUrls) || input.epgUrls.length > MAX_EPG_SOURCES) {
      throw new Error(`epgUrls must contain at most ${MAX_EPG_SOURCES} URLs`);
    }
    const urls = input.epgUrls.map((value, index) =>
      validateHttpUrl(value, `epgUrls[${index}]`, { required: true }).trim()
    );
    config.epgUrls = [...new Set(urls)];
  }

  for (const field of ["enableEpg", "includeSeries", "debug"]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      throw new Error(`Invalid ${field}`);
    }
    if (input[field] !== undefined) config[field] = input[field];
  }

  if (input.epgOffsetHours !== undefined) {
    const offset = Number(input.epgOffsetHours);
    if (!Number.isFinite(offset) || offset < -24 || offset > 24) {
      throw new Error("epgOffsetHours must be between -24 and 24");
    }
    config.epgOffsetHours = offset;
  }

  return config;
}

module.exports = { validateConfig };
