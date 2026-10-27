// xtreamProvider.js
// Extended to support series (shows) via Xtream API:
// - fetchData now retrieves series list when includeSeries !== false
// - fetchSeriesInfo lazily queries per-series episodes (get_series_info)
// episodes are transformed into Stremio 'videos' (season/episode).
const { safeFetch: fetch } = require("../../../urlSafety");
const { parseEPGStream } = require("../epgStreamParser");

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

  if (xtreamUseM3U) {
    // M3U plus mode (series heuristic limited)
    const url =
      `${xtreamUrl}/get.php?username=${encodeURIComponent(xtreamUsername)}` +
      `&password=${encodeURIComponent(xtreamPassword)}` +
      `&type=m3u_plus` +
      (xtreamOutput ? `&output=${encodeURIComponent(xtreamOutput)}` : "");
    const resp = await fetch(url, {
      timeout: 30000,
      headers: { "User-Agent": "Stremio M3U/EPG Addon (xtreamProvider/m3u)" },
    });
    if (!resp.ok) throw new Error("Xtream M3U fetch failed");
    const text = await resp.text();
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
      fetch(`${base}&action=get_live_streams`, { timeout: 30000 }),
      fetch(`${base}&action=get_vod_streams`, { timeout: 30000 }),
      fetch(`${base}&action=get_live_categories`, { timeout: 20000 }).catch(
        () => null,
      ),
      fetch(`${base}&action=get_vod_categories`, { timeout: 20000 }).catch(
        () => null,
      ),
    ]);

    if (!liveResp.ok) throw new Error("Xtream live streams fetch failed");
    if (!vodResp.ok) throw new Error("Xtream VOD streams fetch failed");
    const live = await liveResp.json();
    const vod = await vodResp.json();

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

    addonInstance.channels = (Array.isArray(live) ? live : []).map((s) => {
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

    addonInstance.movies = (Array.isArray(vod) ? vod : []).map((s) => {
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
          fetch(`${base}&action=get_series`, { timeout: 35000 }),
          fetch(`${base}&action=get_series_categories`, {
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
            addonInstance.log?.warn?.("Xtream get_series returned a non-list response", {
              responseType: seriesList === null ? "null" : typeof seriesList,
              durationMs: Date.now() - seriesFetchStartedAt,
            });
          }
        } else {
          addonInstance.log?.warn?.("Xtream get_series returned an HTTP error", {
            status: seriesResp.status,
            durationMs: Date.now() - seriesFetchStartedAt,
          });
        }
      } catch (error) {
        addonInstance.log?.warn?.("Xtream get_series request failed", {
          name: error?.name || "Error",
          code: typeof error?.code === "string" ? error.code : null,
          durationMs: Date.now() - seriesFetchStartedAt,
        });
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
        const epgResp = await fetch(sourceUrl, { timeout: 120000 });
        if (!epgResp.ok || !epgResp.body) {
          if (epgResp.body) epgResp.body.destroy();
          return null;
        }
        return await parseEPGStream(epgResp.body, allowedIds, retentionBudget);
      } catch {
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
    const response = await fetch(`${base}&action=get_vod_info&vod_id=${encodeURIComponent(streamId)}`, {
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
  } catch {
    return null;
  }
}

async function fetchSeriesTmdbId(addonInstance, seriesId, diagnostics = null) {
  const { config } = addonInstance;
  const report = details => {
    if (diagnostics && typeof diagnostics === "object") Object.assign(diagnostics, details);
  };
  if (!seriesId) {
    report({ reason: "provider_series_id_missing", source: "xtream_get_series_info" });
    return null;
  }
  if (!config?.xtreamUrl || !config?.xtreamUsername || !config?.xtreamPassword) {
    report({ reason: "provider_credentials_missing", source: "xtream_get_series_info" });
    return null;
  }
  const base = `${config.xtreamUrl}/player_api.php?username=${encodeURIComponent(config.xtreamUsername)}&password=${encodeURIComponent(config.xtreamPassword)}`;
  try {
    // Discover only needs the series TMDb ID. Avoid constructing and sorting every
    // episode object when a catalogue listing omitted that ID.
    const response = await fetch(
      `${base}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`,
      { timeout: 25000 },
    );
    if (!response.ok) {
      if (response.body && typeof response.body.destroy === "function") response.body.destroy();
      report({
        reason: "provider_http_error",
        source: "xtream_get_series_info",
        httpStatus: response.status
      });
      return null;
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      report({
        reason: "provider_invalid_json",
        source: "xtream_get_series_info",
        errorName: error && error.name ? error.name : "SyntaxError"
      });
      return null;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      report({ reason: "provider_invalid_response", source: "xtream_get_series_info" });
      return null;
    }
    const info = payload.info && typeof payload.info === "object" ? payload.info : {};
    const rawTmdbId = info.tmdb || info.tmdb_id || payload.tmdb || payload.tmdb_id || null;
    const tmdbId = normalizeTmdbId(rawTmdbId);
    report({
      reason: tmdbId
        ? "provider_tmdb_id_found"
        : rawTmdbId ? "provider_tmdb_id_invalid" : "provider_tmdb_id_missing",
      source: "xtream_get_series_info"
    });
    return tmdbId;
  } catch (error) {
    const errorCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
      ? error.code
      : undefined;
    report({
      reason: "provider_request_error",
      source: "xtream_get_series_info",
      errorName: error && error.name ? error.name : "Error",
      ...(errorCode ? { errorCode } : {})
    });
    return null;
  }
}

async function fetchSeriesInfo(addonInstance, seriesId) {
  // For xtream JSON API only
  const { config } = addonInstance;
  if (!seriesId) return { videos: [] };
  if (
    !config ||
    !config.xtreamUrl ||
    !config.xtreamUsername ||
    !config.xtreamPassword
  )
    return { videos: [] };

  const base = `${config.xtreamUrl}/player_api.php?username=${encodeURIComponent(config.xtreamUsername)}&password=${encodeURIComponent(config.xtreamPassword)}`;
  const startedAt = Date.now();
  try {
    const infoResp = await fetch(
      `${base}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`,
      { timeout: 25000 },
    );
    if (!infoResp.ok) {
      return { videos: [], fetchError: `HTTP ${infoResp.status}`, fetchedAt: Date.now() };
    }
    const infoJson = await infoResp.json();
    const videos = [];
    const seriesInfo = infoJson.info && typeof infoJson.info === "object" ? infoJson.info : {};
    const rawTmdbId = seriesInfo.tmdb || seriesInfo.tmdb_id || infoJson.tmdb || infoJson.tmdb_id || null;
    const tmdbId = normalizeTmdbId(rawTmdbId);
    // Xtream returns episodes keyed by season: { "1": [ { id, title, container_extension, episode_num, season, ...}, ... ], "2": [...] }
    const episodesObj = infoJson.episodes || {};
    Object.keys(episodesObj).forEach((seasonKey) => {
      const seasonEpisodes = episodesObj[seasonKey];
      if (Array.isArray(seasonEpisodes)) {
        for (const ep of seasonEpisodes) {
          const epId = ep.id;
          const container = ep.container_extension || "mp4";
          const url = `${config.xtreamUrl}/series/${encodeURIComponent(config.xtreamUsername)}/${encodeURIComponent(config.xtreamPassword)}/${epId}.${container}`;
          // Convert released date to ISO 8601 format
          let releasedRaw = ep.releasedate || ep.added || null;
          let releasedISO = null;
          if (releasedRaw) {
            releasedRaw = String(releasedRaw).trim();
            // Unix timestamp (all digits)
            if (/^\d{9,13}$/.test(releasedRaw)) {
              const ts =
                releasedRaw.length <= 10
                  ? parseInt(releasedRaw, 10) * 1000
                  : parseInt(releasedRaw, 10);
              const d = new Date(ts);
              if (!isNaN(d.getTime())) releasedISO = d.toISOString();
            } else {
              // Try parsing as date string
              const d = new Date(releasedRaw);
              if (!isNaN(d.getTime())) releasedISO = d.toISOString();
            }
          }

          videos.push({
            id: `iptv_series_ep_${epId}`,
            title: ep.title || `Episode ${ep.episode_num}`,
            season: parseInt(ep.season || seasonKey, 10),
            episode: parseInt(ep.episode_num || ep.episode || 0, 10),
            released: releasedISO,
            thumbnail:
              ep.info?.movie_image ||
              ep.info?.episode_image ||
              ep.info?.cover_big ||
              null,
            url,
            stream_id: epId,
          });
        }
      }
    });
    // Sort by season then episode
    videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { videos, tmdbId, fetchedAt: Date.now() };
  } catch (error) {
    const errorCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
      ? error.code
      : undefined;
    return {
      videos: [],
      fetchError: "Provider request failed",
      errorName: error?.name || "Error",
      ...(errorCode ? { errorCode } : {}),
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
  normalizeTmdbId,
};
