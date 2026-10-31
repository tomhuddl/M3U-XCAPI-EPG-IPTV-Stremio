// directProvider.js
// Adds Direct M3U fetching with series detection & per-episode grouping.
// Series grouping heuristic looks for SxxEyy or "Season" patterns.
// Episodes are stored in addonInstance.directSeriesEpisodeIndex for quick meta/stream resolution.

const { safeFetch: fetch } = require('../../../urlSafety');
const { mapWithConcurrency } = require("../../../asyncUtils");
const { getEpgFetchConcurrency, mergeEpgSources } = require("./epgUtils");
const { parseEPGStream } = require('../epgStreamParser');
const { parseRuntimeMinutes } = require('../../../seriesRuntime');
const crypto = require('crypto');

function hash(str) {
    return crypto.createHash('md5').update(str).digest('hex').slice(0, 16);
}

const { baseSeriesName, extractSeasonEpisode } = require("../m3u-parser");

function rebuildDirectEpisodeIndexes(addonInstance, episodesMap) {
    const bySeries = new Map();
    const byId = new Map();

    for (const [seriesId, episodes] of episodesMap.entries()) {
        bySeries.set(seriesId.replace(/^iptv_series_/, ''), episodes);
        for (const episode of episodes) {
            if (episode?.id && !byId.has(episode.id)) {
                byId.set(episode.id, episode);
            }
        }
    }

    addonInstance.directSeriesEpisodeIndex = bySeries;
    addonInstance.directSeriesEpisodeById = byId;
}

async function fetchData(addonInstance, { skipEpg = false } = {}) {
    const { config } = addonInstance;
    const { m3uUrl } = config;

    if (!m3uUrl) throw new Error('Direct provider requires m3uUrl');

    addonInstance.channels = [];
    addonInstance.movies = [];
    addonInstance.series = [];
    addonInstance.directSeriesEpisodeIndex = new Map(); // reset
    addonInstance.directSeriesEpisodeById = new Map(); // reset exact episode lookup index
    if (!skipEpg) addonInstance.epgData = {};
    addonInstance.epgRefreshFailed = false;

    // Fetch playlist
    let playlistText;
    {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);
        try {
            const resp = await fetch(m3uUrl, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Stremio M3U/EPG Addon (directProvider)' }
            });
            if (!resp.ok) throw new Error(`M3U fetch failed (${resp.status})`);
            playlistText = await resp.text();
        } finally {
            clearTimeout(timeout);
        }
    }

    const items = addonInstance.parseM3U(playlistText);

    // Separate by type (already heuristically assigned in parseM3U)
    addonInstance.channels = items.filter(i => i.type === 'tv');
    addonInstance.movies = items.filter(i => i.type === 'movie');

    if (config.includeSeries !== false) {
        // Build episode grouping from items of type 'series'
        const episodeItems = items.filter(i => i.type === 'series');
        const seriesMap = new Map(); // baseName -> series meta
        const episodesMap = new Map(); // seriesId -> episodes array

        for (const ep of episodeItems) {
            const baseName = baseSeriesName(ep.name);
            if (!baseName) continue;

            // Determine season/episode
            const se = extractSeasonEpisode(ep.name) || { season: 1, episode: 0 };
            const seriesHash = hash(baseName);
            const seriesId = `iptv_series_${seriesHash}`;

            if (!seriesMap.has(baseName)) {
                seriesMap.set(baseName, {
                    id: seriesId,
                    series_id: seriesHash,
                    name: baseName,
                    type: 'series',
                    poster: ep.logo || ep.attributes?.['tvg-logo'],
                    plot: ep.attributes?.['plot'] || '',
                    category: ep.category,
                    attributes: {
                        'tvg-logo': ep.logo || ep.attributes?.['tvg-logo'],
                        'group-title': ep.category || ep.attributes?.['group-title'],
                        'plot': ep.attributes?.['plot'] || ''
                    }
                });
                episodesMap.set(seriesId, []);
            }

            const episodeId = `iptv_series_ep_${hash(seriesId + ep.url + se.season + '_' + se.episode)}`;

            const seconds = typeof ep.duration === 'number' ||
                (typeof ep.duration === 'string' && /^\d+(?:\.\d+)?$/.test(ep.duration.trim()))
                ? Number(ep.duration) : NaN;
            const runtimeMinutes = parseRuntimeMinutes(seconds / 60);

            episodesMap.get(seriesId).push({
                id: episodeId,
                title: ep.name,
                season: se.season,
                episode: se.episode,
                released: null,
                thumbnail: ep.logo || ep.attributes?.['tvg-logo'] || null,
                ...(runtimeMinutes !== null ? {
                    runtime: Math.max(1, Math.round(runtimeMinutes)) + ' min',
                    runtimeMinutes
                } : {}),
                url: ep.url,
                stream_id: episodeId
            });
        }

        // Sort episodes before building the series and exact-ID indexes.
        for (const eps of episodesMap.values()) {
            eps.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
        }
        rebuildDirectEpisodeIndexes(addonInstance, episodesMap);

        addonInstance.series = Array.from(seriesMap.values());
    }

    if (!skipEpg) await fetchEpg(addonInstance);
}

async function fetchEpg(addonInstance) {
    const { config } = addonInstance;
    addonInstance.epgData = {};
    addonInstance.epgRefreshFailed = false;
    addonInstance.epgRetentionStatus = null;
    // EPG sources are merged by XMLTV channel ID; an unavailable source does not disable the others.
    if (config.enableEpg) {
        const epgSources = [...new Set([...(config.epgUrl ? [config.epgUrl] : []), ...(Array.isArray(config.epgUrls) ? config.epgUrls : [])].filter(Boolean))];
        const allowedIds = new Set(addonInstance.channels
            .map(channel => channel.attributes?.['tvg-id'] || channel.attributes?.['tvg-name'])
            .filter(Boolean)
            .map(String));
        const retentionBudget = { programmes: 0, textChars: 0 };
        const parsedSources = await mapWithConcurrency(epgSources, getEpgFetchConcurrency(), async sourceUrl => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 120000);
            try {
                const epgResp = await fetch(sourceUrl, {
                    signal: controller.signal,
                    timeout: 120000,
                    headers: { 'User-Agent': 'Stremio M3U/EPG Addon (directProvider/epg)' }
                });
                if (!epgResp || !epgResp.ok || !epgResp.body) {
                    addonInstance.epgRefreshFailed = true;
                    if (epgResp?.body) epgResp.body.destroy();
                    return null;
                }
                return await parseEPGStream(epgResp.body, allowedIds, retentionBudget);
            } catch {
                addonInstance.epgRefreshFailed = true;
                return null;
            } finally {
                clearTimeout(timeout);
            }
        });
        addonInstance.epgData = mergeEpgSources(addonInstance, parsedSources);
    }

}

async function fetchSeriesInfo(addonInstance, seriesId) {
    // For direct provider we already have episodes in directSeriesEpisodeIndex
    if (!seriesId) return { videos: [] };
    // Accept either raw or with prefix
    const normalized = seriesId.toString().replace(/^iptv_series_/, '');
    const episodes = addonInstance.directSeriesEpisodeIndex.get(normalized) || [];
    return { videos: episodes, fetchedAt: Date.now() };
}

module.exports = {
    fetchData,
    fetchEpg,
    fetchSeriesInfo,
    rebuildDirectEpisodeIndexes
};
