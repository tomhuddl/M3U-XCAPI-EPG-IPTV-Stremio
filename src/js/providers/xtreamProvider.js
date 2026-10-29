// xtreamProvider.js
// Extended to support series (shows) via Xtream API:
// - fetchData now retrieves series list when includeSeries !== false
// - fetchSeriesInfo lazily queries per-series episodes (get_series_info)
// episodes are transformed into Stremio 'videos' (season/episode).
const { safeFetch: fetch } = require("../../../urlSafety");
const { parseEPGStream } = require("../epgStreamParser");
const { parseRuntimeMinutes } = require("../../../seriesRuntime");
const xtreamRequests = require("../../../xtreamRequests");

// Consume each JSON body inside its queue slot. Waiting for several response
// headers before reading their bodies would otherwise deadlock a bounded queue.
function fetchJsonResponse(addon, url, options) {
  return xtreamRequests.request(addon, url, () => fetch(url, options), async response => {
    if (!response.ok) {
      response.body?.destroy?.();
      return { ok: false, status: response.status };
    }
    const payload = await response.json();
    return { ok: true, status: response.status, json: async () => payload };
  });
}

function getEpgFetchConcurrency() {
    const parsed = Number.parseInt(process.env.EPG_FETCH_CONCURRENCY, 10);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, 4) : 2;
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(items.length, concurrency);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    }));
    return results;
}

function assertCatalogueIdentifiers(items, idField, label) {
  for (const item of items) {
    const identifier = item && typeof item === "object" && !Array.isArray(item)
      ? item[idField] : null;
    const validIdentifier = typeof identifier === "number"
      ? Number.isSafeInteger(identifier) && identifier > 0
      : typeof identifier === "string" && /^\d+$/.test(identifier) && /[1-9]/.test(identifier);
    if (!validIdentifier) {
      const error = new Error(`Xtream ${label} returned a record without a valid ${idField}`);
      error.code = "XTREAM_INVALID_CATALOGUE";
      throw error;
    }
  }
}

async function fetchData(addonInstance) {
  const { config } = addonInstance;
  const {
    xtreamUrl,
    xtreamUsername,
    xtreamPassword,
    xtreamUseM3U,
    xtreamOutput,
  } = config;

  if (!xtreamUrl || !xtreamUsername || !xtreamPassword) {
    throw new Error("Xtream credentials incomplete");
  }

  addonInstance.channels = [];
  addonInstance.movies = [];
  if (config.includeSeries !== false) addonInstance.series = [];
  addonInstance.epgData = {};
  addonInstance.epgRefreshFailed = false;

  if (xtreamUseM3U) {
    // M3U plus mode (series heuristic limited)
    const url =
      `${xtreamUrl}/get.php?username=${encodeURIComponent(xtreamUsername)}` +
      `&password=${encodeURIComponent(xtreamPassword)}` +
      `&type=m3u_plus` +
      (xtreamOutput ? `&output=${encodeURIComponent(xtreamOutput)}` : "");
    const text = await xtreamRequests.request(addonInstance, url, () => fetch(url, {
      timeout: 30000,
      headers: { "User-Agent": "Stremio M3U/EPG Addon (xtreamProvider/m3u)" },
    }), async resp => {
      if (!resp.ok) {
        resp.body?.destroy?.();
        throw new Error("Xtream M3U fetch failed");
      }
      return resp.text();
    });
    const items = addonInstance.parseM3U(text);

    addonInstance.channels = items.filter((i) => i.type === "tv");
    addonInstance.movies = items.filter((i) => i.type === "movie");

    if (config.includeSeries !== false) {
      const seriesCandidates = items.filter((i) => i.type === "series");
      // Reduce duplication by grouping by cleaned series name
      const seen = new Map();
      for (const sc of seriesCandidates) {
        const baseName = sc.name.replace(/\bS\d{1,2}E\d{1,2}\b.*$/i, "").trim();
        if (!seen.has(baseName)) {
          seen.set(baseName, {
            id: `iptv_series_${cryptoHash(baseName)}`,
            series_id: cryptoHash(baseName),
            name: baseName,
            type: "series",
            poster: sc.logo || sc.attributes?.["tvg-logo"],
            plot: sc.attributes?.["plot"] || "",
            category: sc.category,
            attributes: {
              "tvg-logo": sc.logo || sc.attributes?.["tvg-logo"],
              "group-title": sc.category || sc.attributes?.["group-title"],
              plot: sc.attributes?.["plot"] || "",
            },
          });
        }
      }
      addonInstance.series = Array.from(seen.values());
    }
  } else {
    // JSON API mode
    const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;
    // Fetch streams + category lists in parallel to map category_id -> category_name
    const [liveResp, vodResp, liveCatsResp, vodCatsResp] = await Promise.all([
      fetchJsonResponse(addonInstance, `${base}&action=get_live_streams`, { timeout: 30000 }),
      fetchJsonResponse(addonInstance, `${base}&action=get_vod_streams`, { timeout: 30000 }),
      fetchJsonResponse(addonInstance, `${base}&action=get_live_categories`, { timeout: 20000 }).catch(
        () => null,
      ),
      fetchJsonResponse(addonInstance, `${base}&action=get_vod_categories`, { timeout: 20000 }).catch(
        () => null,
      ),
    ]);

    if (!liveResp.ok) throw new Error("Xtream live streams fetch failed");
    if (!vodResp.ok) throw new Error("Xtream VOD streams fetch failed");
    const live = await liveResp.json();
    const vod = await vodResp.json();
    if (!Array.isArray(live)) throw new Error("Xtream live streams returned a non-list response");
    if (!Array.isArray(vod)) throw new Error("Xtream VOD streams returned a non-list response");
    assertCatalogueIdentifiers(live, "stream_id", "live streams");
    assertCatalogueIdentifiers(vod, "stream_id", "VOD streams");

    let liveCatMap = {};
    let vodCatMap = {};
    try {
      if (liveCatsResp && liveCatsResp.ok) {
        const arr = await liveCatsResp.json();
        if (Array.isArray(arr)) {
          for (const c of arr) {
            if (c && c.category_id && c.category_name)
              liveCatMap[c.category_id] = c.category_name;
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (vodCatsResp && vodCatsResp.ok) {
        const arr = await vodCatsResp.json();
        if (Array.isArray(arr)) {
          for (const c of arr) {
            if (c && c.category_id && c.category_name)
              vodCatMap[c.category_id] = c.category_name;
          }
        }
      }
    } catch {
      /* ignore */
    }

    addonInstance.channels = live.map((s) => {
      const cat =
        liveCatMap[s.category_id] || s.category_name ||
        (s.category_id != null ? String(s.category_id) : "") || "Live";
      return {
        id: `iptv_live_${s.stream_id}`,
        name: s.name,
        type: "tv",
        url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
        logo: s.stream_icon,
        category: cat,
        epg_channel_id: s.epg_channel_id,
        attributes: {
          "tvg-logo": s.stream_icon,
          "tvg-id": s.epg_channel_id,
          "group-title": cat,
        },
      };
    });

    addonInstance.movies = vod.map((s) => {
      const cat = vodCatMap[s.category_id] || s.category_name || "Movies";
      return {
        id: `iptv_vod_${s.stream_id}`,
        name: s.name,
        type: "movie",
        url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.${s.container_extension}`,
        poster: s.stream_icon,
        plot: s.plot,
        // TMDb ID is an identifier only; display metadata is fetched from TMDb.
        tmdbId: normalizeTmdbId(s.tmdb_id || s.tmdb),
        category: cat,
        attributes: {
          "tvg-logo": s.stream_icon,
          "group-title": cat,
          plot: s.plot,
        },
      };
    });

    if (config.includeSeries !== false) {
      const seriesFetchStartedAt = Date.now();
      try {
        const [seriesResp, seriesCatsResp] = await Promise.all([
          fetchJsonResponse(addonInstance, `${base}&action=get_series`, { timeout: 35000 }),
          fetchJsonResponse(addonInstance, `${base}&action=get_series_categories`, {
            timeout: 20000,
          }).catch((error) => {
            return null;
          }),
        ]);
        let seriesCatMap = {};
        try {
          if (seriesCatsResp && seriesCatsResp.ok) {
            const arr = await seriesCatsResp.json();
            if (Array.isArray(arr)) {
              for (const c of arr) {
                if (c && c.category_id && c.category_name)
                  seriesCatMap[c.category_id] = c.category_name;
              }
            }
          }
        } catch {
          /* ignore */
        }
        if (seriesResp.ok) {
          const seriesList = await seriesResp.json();
          if (Array.isArray(seriesList)) {
            assertCatalogueIdentifiers(seriesList, "series_id", "get_series");
            addonInstance.series = seriesList.map((s) => {
              const cat =
                seriesCatMap[s.category_id] || s.category_name || "Series";
              return {
                id: `iptv_series_${s.series_id}`,
                series_id: s.series_id,
                tmdbId: normalizeTmdbId(s.tmdb || s.tmdb_id),
                name: s.name,
                type: "series",
                poster: s.cover,
                plot: s.plot,
                category: cat,
                attributes: {
                  "tvg-logo": s.cover,
                  "group-title": cat,
                  plot: s.plot,
                },
              };
            });
            const summary = { count: seriesList.length, durationMs: Date.now() - seriesFetchStartedAt };
            if (seriesList.length) {
              addonInstance.log?.info?.("Xtream series loaded", summary);
            } else {
              addonInstance.log?.warn?.("Xtream get_series returned an empty list", summary);
            }
          } else {
            throw new Error("Xtream get_series returned a non-list response");
          }
        } else {
          const error = new Error("Xtream series list fetch failed");
          error.status = seriesResp.status;
          throw error;
        }
      } catch (error) {
        addonInstance.log?.warn?.("Xtream get_series request failed", {
          name: error?.name || "Error",
          code: typeof error?.code === "string" ? error.code : null,
          ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
          durationMs: Date.now() - seriesFetchStartedAt,
        });
        // A failed section is not an observed empty list. Preserve the complete
        // provider snapshot instead of confirming removals after upstream failures.
        throw error;
      }
    }
  }

  // Merge the selected primary XMLTV feed with any additional feeds.
  if (config.enableEpg) {
    const customEpgUrl = config.epgUrl && typeof config.epgUrl === "string" && config.epgUrl.trim()
      ? config.epgUrl.trim() : null;
    const primaryEpgUrl = customEpgUrl || xtreamUrl + "/xmltv.php?username=" +
      encodeURIComponent(xtreamUsername) + "&password=" + encodeURIComponent(xtreamPassword);
    const epgSources = [...new Set([primaryEpgUrl, ...(Array.isArray(config.epgUrls) ? config.epgUrls : [])].filter(Boolean))];
    const allowedIds = new Set(addonInstance.channels
      .map(channel => channel.attributes?.["tvg-id"] || channel.attributes?.["tvg-name"])
      .filter(Boolean)
      .map(String));
    const retentionBudget = { programmes: 0, textChars: 0 };
    const parsedSources = await mapWithConcurrency(epgSources, getEpgFetchConcurrency(), async sourceUrl => {
      try {
        return await xtreamRequests.request(addonInstance, sourceUrl,
          () => fetch(sourceUrl, { timeout: 120000 }), async epgResp => {
            if (!epgResp || !epgResp.ok || !epgResp.body) {
              addonInstance.epgRefreshFailed = true;
              if (epgResp?.body) epgResp.body.destroy();
              return null;
            }
            return await parseEPGStream(epgResp.body, allowedIds, retentionBudget);
          });
      } catch {
        addonInstance.epgRefreshFailed = true;
        return null;
      }
    });
    const merged = {};
    for (const parsed of parsedSources) {
      if (!parsed) continue;
      for (const [channelId, programmes] of Object.entries(parsed)) {
        if (!merged[channelId]) merged[channelId] = [];
        merged[channelId].push(...programmes);
      }
    }
    for (const channelId of Object.keys(merged)) {
      const seen = new Set();
      merged[channelId] = merged[channelId]
        .filter(programme => {
          const key = [programme.start, programme.stop, programme.title].join("|");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    }
    addonInstance.epgData = merged;
  }

}

function normalizeTmdbId(value) {
  const id = String(value ?? "").trim();
  return /^\d{1,12}$/.test(id) && Number(id) > 0 ? id : null;
}

async function fetchMovieInfo(addonInstance, streamId) {
  const { config } = addonInstance;
  if (!streamId || !config?.xtreamUrl || !config?.xtreamUsername || !config?.xtreamPassword) return null;
  const base = `${config.xtreamUrl}/player_api.php?username=${encodeURIComponent(config.xtreamUsername)}&password=${encodeURIComponent(config.xtreamPassword)}`;
  try {
    const response = await fetchJsonResponse(addonInstance, `${base}&action=get_vod_info&vod_id=${encodeURIComponent(streamId)}`, {
      timeout: 20000,
      // Reuse a connection for this provider fallback when its validated DNS
      // addresses are unchanged; safeFetch still validates DNS on every request.
      reuseConnection: true,
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const info = payload && payload.info && typeof payload.info === "object" ? payload.info : {};
    const tmdbId = info.tmdb_id || info.tmdb || payload.tmdb_id || payload.tmdb || null;
    return { tmdbId: normalizeTmdbId(tmdbId) };
  } catch (error) {
    if (xtreamRequests.isXtreamRateLimitError(error)) throw error;
    return null;
  }
}

// Share only in-flight raw responses. A full detail request, an ID-only lookup
// and an average-runtime backfill may ask for the same series simultaneously.
// Once they settle, no raw episode payload remains in this map.
const seriesRequests = new WeakMap();

function providerRequestDiagnostic(error) {
  const errorCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
    ? error.code : undefined;
  return {
    reason: "provider_request_error",
    source: "xtream_get_series_info",
    errorName: error?.name || "Error",
    ...(errorCode ? { errorCode } : {})
  };
}

function requestSeriesPayload(addonInstance, seriesId) {
  let inFlight = seriesRequests.get(addonInstance);
  if (!inFlight) {
    inFlight = new Map();
    seriesRequests.set(addonInstance, inFlight);
  }
  const key = String(Number(addonInstance.lastUpdate) || 0) + ":" + String(seriesId);
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const { config } = addonInstance;
    const base = `${config.xtreamUrl}/player_api.php?username=${encodeURIComponent(config.xtreamUsername)}&password=${encodeURIComponent(config.xtreamPassword)}`;
    try {
      const url = `${base}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`;
      return await xtreamRequests.request(addonInstance, url,
        () => fetch(url, { timeout: 25000, reuseConnection: true }), async response => {
          if (!response.ok) {
            if (response.body && typeof response.body.destroy === "function") response.body.destroy();
            return { diagnostic: {
              reason: "provider_http_error", source: "xtream_get_series_info", httpStatus: response.status
            } };
          }
          let payload;
          try {
            payload = await response.json();
          } catch (error) {
            return { diagnostic: {
              reason: "provider_invalid_json", source: "xtream_get_series_info",
              errorName: error?.name || "SyntaxError"
            } };
          }
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return { diagnostic: { reason: "provider_invalid_response", source: "xtream_get_series_info" } };
          }
          return { payload };
        });
    } catch (error) {
      if (xtreamRequests.isXtreamRateLimitError(error)) return { diagnostic: {
        reason: "provider_http_error", source: "xtream_get_series_info", httpStatus: 429, retryAt: error.retryAt
      } };
      return { diagnostic: providerRequestDiagnostic(error) };
    }
  })();
  inFlight.set(key, task);
  task.finally(() => {
    if (inFlight.get(key) === task) inFlight.delete(key);
  });
  return task;
}

function hasSeriesCredentials(addonInstance) {
  const config = addonInstance?.config;
  return Boolean(config?.xtreamUrl && config?.xtreamUsername && config?.xtreamPassword);
}

function episodeRuntimeMinutes(episode) {
  const info = episode?.info && typeof episode.info === "object" ? episode.info : {};
  for (const value of [info.duration_secs, episode?.duration_secs]) {
    const seconds = typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))
      ? Number(value) : NaN;
    const minutes = parseRuntimeMinutes(seconds / 60);
    if (minutes !== null) return minutes;
  }
  for (const value of [info.duration, episode?.duration]) {
    // Xtream's unlabelled numeric duration is ambiguous; use its explicit seconds
    // field or a clock/minute string instead of guessing the unit.
    if (typeof value !== "string" || !/[:a-z]/i.test(value)) continue;
    const minutes = parseRuntimeMinutes(value);
    if (minutes !== null) return minutes;
  }
  for (const value of [info.runtime, episode?.runtime]) {
    const minutes = parseRuntimeMinutes(value);
    if (minutes !== null) return minutes;
  }
  return null;
}

async function fetchSeriesTmdbId(addonInstance, seriesId, diagnostics = null) {
  const report = details => {
    if (diagnostics && typeof diagnostics === "object") Object.assign(diagnostics, details);
  };
  if (!seriesId) {
    report({ reason: "provider_series_id_missing", source: "xtream_get_series_info" });
    return null;
  }
  if (!hasSeriesCredentials(addonInstance)) {
    report({ reason: "provider_credentials_missing", source: "xtream_get_series_info" });
    return null;
  }
  const { payload, diagnostic } = await requestSeriesPayload(addonInstance, seriesId);
  if (!payload) { report(diagnostic); return null; }
  const info = payload.info && typeof payload.info === "object" ? payload.info : {};
  const rawTmdbId = info.tmdb || info.tmdb_id || payload.tmdb || payload.tmdb_id || null;
  const tmdbId = normalizeTmdbId(rawTmdbId);
  report({
    reason: tmdbId ? "provider_tmdb_id_found" : rawTmdbId ? "provider_tmdb_id_invalid" : "provider_tmdb_id_missing",
    source: "xtream_get_series_info"
  });
  return tmdbId;
}

async function fetchSeriesRuntimeInfo(addonInstance, seriesId, diagnostics = null) {
  const report = details => {
    if (diagnostics && typeof diagnostics === "object") Object.assign(diagnostics, details, { source: "xtream_get_series_info" });
  };
  if (!seriesId || !hasSeriesCredentials(addonInstance)) {
    report({ reason: !seriesId ? "provider_series_id_missing" : "provider_credentials_missing" });
    return null;
  }
  const { payload, diagnostic } = await requestSeriesPayload(addonInstance, seriesId);
  if (!payload) { report(diagnostic || { reason: "provider_series_info_unavailable" }); return null; }
  const groups = payload.episodes;
  if (groups == null || typeof groups !== "object") {
    report({ reason: groups == null ? "provider_episodes_missing" : "provider_episodes_invalid" });
    return null;
  }
  const episodes = [];
  // The details parser already accepts season arrays keyed by either a JSON
  // object or a JSON array. Runtime lookup must accept those same layouts.
  for (const [seasonKey, rows] of Object.entries(groups)) {
    if (rows == null) continue; // Empty slots in indexed season lists contain no playable episodes.
    if (!Array.isArray(rows)) { report({ reason: "provider_season_episodes_invalid" }); return null; }
    for (const episode of rows) {
      if (!episode || typeof episode !== "object" || Array.isArray(episode)) {
        report({ reason: "provider_episode_invalid" }); return null;
      }
      if (episode.id == null || String(episode.id).trim() === "") {
        report({ reason: "provider_episode_id_missing" }); return null;
      }
      episodes.push({
        id: "iptv_series_ep_" + episode.id,
        season: Number.parseInt(episode.season ?? seasonKey, 10),
        episode: Number.parseInt(episode.episode_num ?? episode.episode ?? 0, 10),
        runtimeMinutes: episodeRuntimeMinutes(episode)
      });
    }
  }
  const info = payload.info && typeof payload.info === "object" ? payload.info : {};
  report({ reason: episodes.length ? "provider_episodes_loaded" : "provider_episodes_empty", episodeCount: episodes.length });
  return { episodes, tmdbId: normalizeTmdbId(info.tmdb || info.tmdb_id || payload.tmdb || payload.tmdb_id), fetchedAt: Date.now() };
}

async function fetchSeriesInfo(addonInstance, seriesId) {
  // For Xtream JSON API only. Episode runtime remains in the persistent detail
  // record so later average calculations can reuse it without another request.
  const { config } = addonInstance;
  if (!seriesId || !hasSeriesCredentials(addonInstance)) return { videos: [] };
  try {
    const { payload: infoJson, diagnostic } = await requestSeriesPayload(addonInstance, seriesId);
    if (!infoJson) {
      return {
        videos: [],
        fetchError: diagnostic?.httpStatus ? `HTTP ${diagnostic.httpStatus}` : "Provider request failed",
        ...(diagnostic?.errorName ? { errorName: diagnostic.errorName } : {}),
        ...(diagnostic?.errorCode ? { errorCode: diagnostic.errorCode } : {}),
        ...(diagnostic?.retryAt ? { retryAt: diagnostic.retryAt } : {}),
        fetchedAt: Date.now()
      };
    }
    const videos = [];
    const seriesInfo = infoJson.info && typeof infoJson.info === "object" ? infoJson.info : {};
    const rawTmdbId = seriesInfo.tmdb || seriesInfo.tmdb_id || infoJson.tmdb || infoJson.tmdb_id || null;
    const tmdbId = normalizeTmdbId(rawTmdbId);
    const episodesObj = infoJson.episodes || {};
    for (const [seasonKey, seasonEpisodes] of Object.entries(episodesObj)) {
      if (!Array.isArray(seasonEpisodes)) continue;
      for (const ep of seasonEpisodes) {
        const epId = ep.id;
        const container = ep.container_extension || "mp4";
        const url = `${config.xtreamUrl}/series/${encodeURIComponent(config.xtreamUsername)}/${encodeURIComponent(config.xtreamPassword)}/${epId}.${container}`;
        const runtimeMinutes = episodeRuntimeMinutes(ep);
        let releasedRaw = ep.releasedate || ep.added || null;
        let releasedISO = null;
        if (releasedRaw) {
          releasedRaw = String(releasedRaw).trim();
          if (/^\d{9,13}$/.test(releasedRaw)) {
            const ts = releasedRaw.length <= 10 ? Number.parseInt(releasedRaw, 10) * 1000 : Number.parseInt(releasedRaw, 10);
            const date = new Date(ts);
            if (!Number.isNaN(date.getTime())) releasedISO = date.toISOString();
          } else {
            const date = new Date(releasedRaw);
            if (!Number.isNaN(date.getTime())) releasedISO = date.toISOString();
          }
        }
        videos.push({
          id: `iptv_series_ep_${epId}`,
          title: ep.title || `Episode ${ep.episode_num}`,
          season: Number.parseInt(ep.season ?? seasonKey, 10),
          episode: Number.parseInt(ep.episode_num ?? ep.episode ?? 0, 10),
          released: releasedISO,
          thumbnail: ep.info?.movie_image || ep.info?.episode_image || ep.info?.cover_big || null,
          ...(runtimeMinutes !== null ? {
            runtime: Math.max(1, Math.round(runtimeMinutes)) + " min",
            runtimeMinutes
          } : {}),
          url,
          stream_id: epId
        });
      }
    }
    videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { videos, tmdbId, fetchedAt: Date.now() };
  } catch (error) {
    const diagnostic = providerRequestDiagnostic(error);
    return {
      videos: [], fetchError: "Provider request failed", errorName: diagnostic.errorName,
      ...(diagnostic.errorCode ? { errorCode: diagnostic.errorCode } : {}),
      fetchedAt: Date.now()
    };
  }
}

function cryptoHash(text) {
  return require("crypto")
    .createHash("md5")
    .update(text)
    .digest("hex")
    .slice(0, 12);
}

module.exports = {
  fetchData,
  fetchMovieInfo,
  fetchSeriesInfo,
  fetchSeriesTmdbId,
  fetchSeriesRuntimeInfo,
  normalizeTmdbId,
};
