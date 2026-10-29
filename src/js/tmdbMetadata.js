const { safeFetch } = require("../../urlSafety");
const LRUCache = require("../../lruCache");
const { parseRuntimeMinutes, averageEpisodeRuntime, isEligibleRuntimeEpisode } = require("../../seriesRuntime");
const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";
const TMDB_API_KEY = (process.env.TMDB_API_KEY || "").trim();
const CACHE_TTL_MS = parsePositiveInteger(process.env.TMDB_CACHE_TTL_MS, 14 * 24 * 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000);
const cache = new LRUCache({
  max: parsePositiveInteger(process.env.TMDB_CACHE_MAX_ENTRIES, 1000, 1, 5000),
  ttl: CACHE_TTL_MS,
});
// Missing TMDb records are common when provider IDs are stale or incorrect.
// Cache only confirmed 404s briefly; transient errors must remain retryable.
const negativeCache = new LRUCache({
  max: parsePositiveInteger(process.env.TMDB_NEGATIVE_CACHE_MAX_ENTRIES, 500, 1, 5000),
  ttl: parsePositiveInteger(process.env.TMDB_NEGATIVE_CACHE_TTL_MS, 5 * 60 * 1000, 1000, 60 * 60 * 1000),
});
const pending = new Map();
const runtimePending = new Map();
const SERIES_DETAILS_QUERY = "?language=en-GB&append_to_response=aggregate_credits,images,external_ids&include_image_language=en,null";
const COMPLETE_SEASON_RUNTIME_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const PARTIAL_SEASON_RUNTIME_TTL_MS = parsePositiveInteger(process.env.OMDB_MISSING_DATA_RETRY_MS, 12 * 60 * 60 * 1000, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const MAX_MAIN_CAST = 4;

function parsePositiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= min ? Math.min(parsed, max) : fallback;
}

function validTmdbId(value) {
  const id = String(value ?? "").trim();
  return /^\d{1,12}$/.test(id) && Number(id) > 0 ? id : null;
}

function imageUrl(path, size = "w500") {
  return typeof path === "string" && path.startsWith("/") ? TMDB_IMAGE_BASE + size + path : undefined;
}

function dateYear(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  return year >= 1800 && year <= 3000 ? year : undefined;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueNames(items, selector, limit = 20) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const name = nonEmpty(selector(item));
    if (name && !seen.has(name)) {
      seen.add(name);
      result.push(name);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function tmdbConfigured() {
  return TMDB_API_KEY.length > 0;
}

const lookupStats = {
  calls: 0,
  apiRequests: 0,
  cacheHits: 0,
  negativeCacheHits: 0,
  inFlightJoins: 0,
  notConfigured: 0,
  notFound404: 0,
  httpErrors: 0,
  invalidJson: 0,
  invalidResponses: 0,
  requestErrors: 0,
  successfulResponses: 0
};

function getDiagnostics() {
  return {
    apiKeyConfigured: tmdbConfigured(),
    ...lookupStats
  };
}

function recordLookupDiagnostic(target, details) {
  if (target && typeof target === "object" && details && typeof details === "object") {
    Object.assign(target, details);
  }
}
async function request(path, { refresh = false, diagnostics = null } = {}) {
  lookupStats.calls++;
  if (!tmdbConfigured()) {
    lookupStats.notConfigured++;
    recordLookupDiagnostic(diagnostics, { reason: "tmdb_not_configured" });
    return null;
  }
  const cacheKey = "tmdb:" + path;
  const cached = cache.get(cacheKey);
  if (!refresh && cached !== undefined) {
    lookupStats.cacheHits++;
    recordLookupDiagnostic(diagnostics, { reason: "tmdb_cached_response", source: "memory_cache" });
    return cached;
  }
  if (!refresh && negativeCache.has(cacheKey)) {
    lookupStats.negativeCacheHits++;
    recordLookupDiagnostic(diagnostics, {
      reason: "tmdb_not_found",
      source: "negative_cache",
      httpStatus: 404
    });
    return null;
  }
  if (pending.has(cacheKey)) {
    lookupStats.inFlightJoins++;
    const result = await pending.get(cacheKey);
    recordLookupDiagnostic(diagnostics, {
      reason: result ? "tmdb_response_received" : "tmdb_lookup_failed",
      source: "in_flight"
    });
    return result;
  }

  const task = (async () => {
    let status = null;
    try {
      const separator = path.includes("?") ? "&" : "?";
      const url = TMDB_API_BASE + path + separator + "api_key=" + encodeURIComponent(TMDB_API_KEY);
      lookupStats.apiRequests++;
      const response = await safeFetch(url, {
        timeout: 12000,
        // Opt in only for TMDb requests. safeFetch still resolves and validates
        // DNS for every request before selecting an agent pinned to those addresses.
        reuseConnection: true,
        headers: { Accept: "application/json", "User-Agent": "M3U-XCAPI-EPG-IPTV-Stremio" },
      });
      status = response.status;
      if (!response.ok) {
        // Do not leave an unused upstream response body draining in the
        // background. Explicitly close it so repeated HTTP failures release
        // sockets and buffers promptly.
        if (response.body && typeof response.body.destroy === "function") {
          response.body.destroy();
        }
        if (response.status === 404) {
          negativeCache.set(cacheKey, true);
          lookupStats.notFound404++;
        } else {
          lookupStats.httpErrors++;
        }
        recordLookupDiagnostic(diagnostics, {
          reason: response.status === 404 ? "tmdb_not_found" : "tmdb_http_error",
          httpStatus: response.status
        });
        return null;
      }
      let data;
      try {
        data = JSON.parse(await response.text());
      } catch (error) {
        lookupStats.invalidJson++;
        recordLookupDiagnostic(diagnostics, {
          reason: "tmdb_invalid_json",
          httpStatus: status,
          errorName: error && error.name ? error.name : "SyntaxError"
        });
        return null;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        lookupStats.invalidResponses++;
        recordLookupDiagnostic(diagnostics, { reason: "tmdb_invalid_response", httpStatus: status });
        return null;
      }
      cache.set(cacheKey, data);
      lookupStats.successfulResponses++;
      recordLookupDiagnostic(diagnostics, {
        reason: "tmdb_response_received",
        source: "api",
        httpStatus: status
      });
      return data;
    } catch (error) {
      lookupStats.requestErrors++;
      const errorCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : undefined;
      recordLookupDiagnostic(diagnostics, {
        reason: "tmdb_request_error",
        ...(status ? { httpStatus: status } : {}),
        errorName: error && error.name ? error.name : "Error",
        ...(errorCode ? { errorCode } : {})
      });
      return null;
    } finally {
      pending.delete(cacheKey);
    }
  })();
  pending.set(cacheKey, task);
  return task;
}

function metadataLinks(details, credits, mediaType) {
  const links = [];
  for (const genre of Array.isArray(details?.genres) ? details.genres : []) {
    if (nonEmpty(genre?.name) && Number.isSafeInteger(genre.id) && genre.id > 0) {
      links.push({
        name: genre.name,
        category: "Genres",
        url: "https://www.themoviedb.org/genre/" + genre.id,
      });
    }
  }
  const cast = Array.isArray(credits?.cast) ? credits.cast : [];
  for (const person of cast.slice(0, MAX_MAIN_CAST)) {
    if (nonEmpty(person?.name) && Number.isSafeInteger(person.id) && person.id > 0) {
      links.push({
        name: person.name,
        category: "Cast",
        url: "https://www.themoviedb.org/person/" + person.id,
      });
    }
  }
  // Directors are shown for movies only; use the plural category so multiple
  // credited directors are grouped under the correct label in Stremio.
  if (mediaType === "movie") {
    const crew = Array.isArray(credits?.crew) ? credits.crew : [];
    const seen = new Set();
    let directorCount = 0;
    for (const person of crew) {
      if (person?.job !== "Director") continue;
      // Preserve the previous first-ten-credits limit without allocating a
      // filtered directors array and a second sliced array for every catalogue item.
      if (directorCount >= 10) break;
      directorCount++;
      if (nonEmpty(person?.name) && Number.isSafeInteger(person.id) && person.id > 0 && !seen.has(person.id)) {
        seen.add(person.id);
        links.push({
          name: person.name,
          category: "Directors",
          url: "https://www.themoviedb.org/person/" + person.id,
        });
      }
    }
  }
  // Writers are supplied in TMDb credit order. The HTTP response layer
  // keeps this category visible only to the iOS Stremio client.
  const crew = Array.isArray(credits?.crew) ? credits.crew : [];
  // Only include explicit writing credits. Creator/developed-by and editorial
  // roles can identify people who did not write episodes or scripts themselves.
  const seenWriters = new Set();
  for (const person of crew) {
    // Movie credits use person.job; TV aggregate credits use person.jobs[].
    // Check the relevant role directly to avoid building temporary role arrays
    // for every credited crew member on each catalogue metadata response.
    const isWriter = person?.job != null && String(person.job) === "Writer"
      || Array.isArray(person?.jobs) && person.jobs.some(job => job?.job != null && String(job.job) === "Writer");
    if (isWriter &&
        nonEmpty(person?.name) &&
        Number.isSafeInteger(person.id) && person.id > 0 &&
        !seenWriters.has(person.id)) {
      seenWriters.add(person.id);
      links.push({
        name: person.name,
        category: "Writers",
        url: "https://www.themoviedb.org/person/" + person.id,
      });
    }
  }
  return links;
}

function selectLogo(images) {
  const logos = Array.isArray(images?.logos) ? images.logos : [];
  const selected = logos.find(item => item?.iso_639_1 === "en" && typeof item.file_path === "string" && item.file_path.startsWith("/"))
    || logos.find(item => item?.iso_639_1 == null && typeof item.file_path === "string" && item.file_path.startsWith("/"))
    || logos.find(item => typeof item?.file_path === "string" && item.file_path.startsWith("/"));
  return imageUrl(selected?.file_path, "w500");
}

function mapMovieMetadata(details, credits, videos, images) {
  if (!details || !nonEmpty(details.title)) return null;
  const logo = selectLogo(images);
  const directors = uniqueNames(credits?.crew, person => person.job === "Director" ? person.name : null, 10);
  const cast = uniqueNames(credits?.cast, person => person.name, MAX_MAIN_CAST);
  const trailer = Array.isArray(videos?.results)
    ? videos.results.find(video => video.site === "YouTube" && video.type === "Trailer" && video.key)
      || videos.results.find(video => video.site === "YouTube" && video.key)
    : null;
  const genres = Array.isArray(details.genres) ? uniqueNames(details.genres, genre => genre.name, 20) : [];
  const year = dateYear(details.release_date);
  return stripEmpty({
    name: details.title,
    imdbId: nonEmpty(details.imdb_id) || nonEmpty(details.external_ids?.imdb_id),
    description: nonEmpty(details.overview),
    poster: imageUrl(details.poster_path),
    background: imageUrl(details.backdrop_path, "w1280"),
    logo,
    genres,
    year,
    releaseInfo: year ? String(year) : undefined,
    runtime: Number.isFinite(details.runtime) && details.runtime > 0 ? details.runtime + " min" : undefined,
    rating: Number.isFinite(details.vote_average) && details.vote_count > 0 ? Number(details.vote_average).toFixed(1) : undefined,
    director: directors,
    cast,
    links: metadataLinks(details, credits, "movie"),
    trailer: trailer ? { id: trailer.key, title: nonEmpty(trailer.name) || "Trailer", site: "YouTube" } : undefined,
  });
}

async function getMovieCatalogMetadata(tmdbId, options = {}) {
  const id = validTmdbId(tmdbId);
  if (!id) return null;
  // Include images in the appended response so Discover can use TMDb's
  // transparent title logo without adding a second network round-trip per movie.
  const details = await request("/movie/" + id + "?language=en-GB&append_to_response=credits,images,external_ids&include_image_language=en,null", options);
  return mapMovieMetadata(details, details?.credits, null, details?.images);
}

async function getSeriesCatalogMetadata(tmdbId, options = {}) {
  const diagnostics = options?.diagnostics;
  const id = validTmdbId(tmdbId);
  if (!id) {
    recordLookupDiagnostic(diagnostics, {
      reason: tmdbId == null || String(tmdbId).trim() === ""
        ? "tmdb_id_missing"
        : "tmdb_id_invalid"
    });
    return null;
  }
  if (!tmdbConfigured()) {
    recordLookupDiagnostic(diagnostics, { reason: "tmdb_not_configured", tmdbId: id });
    return null;
  }
  // Append images alongside aggregate credits so Discover receives the
  // transparent title logo without an extra request for each series.
  const details = await request("/tv/" + id + SERIES_DETAILS_QUERY, options);
  const metadata = mapSeriesMetadata(details, details?.aggregate_credits, null, details?.images);
  if (metadata) {
    recordLookupDiagnostic(diagnostics, { reason: "tmdb_match_found", tmdbId: id });
  } else if (
    diagnostics &&
    ["tmdb_response_received", "tmdb_cached_response"].includes(diagnostics.reason)
  ) {
    recordLookupDiagnostic(diagnostics, {
      reason: "tmdb_response_missing_series_name",
      tmdbId: id
    });
  }
  return metadata;
}

async function getMovieMetadata(tmdbId) {
  const id = validTmdbId(tmdbId);
  if (!id) return null;
  // Reuse the exact details/credits/images response already fetched for Discover.
  // Only trailers need a separate request; the shared request cache deduplicates it
  // when another detail request for the same movie is already in progress.
  const [details, videos] = await Promise.all([
    request("/movie/" + id + "?language=en-GB&append_to_response=credits,images&include_image_language=en,null"),
    request("/movie/" + id + "/videos?language=en-GB"),
  ]);
  return mapMovieMetadata(details, details?.credits, videos, details?.images);
}

function mapSeriesMetadata(details, credits, videos, images) {
  if (!details || !nonEmpty(details.name)) return null;
  const logo = selectLogo(images);
  const cast = uniqueNames(credits?.cast, person => person.name, MAX_MAIN_CAST);
  const trailer = Array.isArray(videos?.results)
    ? videos.results.find(video => video.site === "YouTube" && video.type === "Trailer" && video.key)
      || videos.results.find(video => video.site === "YouTube" && video.key)
    : null;
  const year = dateYear(details.first_air_date);
  const endYear = dateYear(details.last_air_date);
  const stillRunning = details.status === "Returning Series" || details.status === "In Production";
  const releaseInfo = year ? String(year) + (stillRunning ? "-" : endYear ? "-" + endYear : "") : undefined;
  const episodeRuntime = Array.isArray(details.episode_run_time)
    ? details.episode_run_time.find(n => Number.isFinite(n) && n > 0)
    : undefined;
  return stripEmpty({
    name: details.name,
    imdbId: nonEmpty(details.external_ids?.imdb_id) || nonEmpty(details.imdb_id),
    description: nonEmpty(details.overview),
    poster: imageUrl(details.poster_path),
    background: imageUrl(details.backdrop_path, "w1280"),
    logo,
    genres: Array.isArray(details.genres) ? uniqueNames(details.genres, genre => genre.name, 20) : [],
    year,
    releaseInfo,
    runtime: episodeRuntime ? episodeRuntime + " min" : undefined,
    runtimeSeasons: Array.isArray(details.seasons)
      ? [...new Map(details.seasons.filter(season =>
          Number.isSafeInteger(season?.season_number) && season.season_number > 0 && season.season_number <= 1000
        ).map(season => [season.season_number, {
          season: season.season_number,
          episodeCount: Number.isSafeInteger(season.episode_count) && season.episode_count >= 0
            ? season.episode_count : null
        }])).values()].sort((a, b) => a.season - b.season)
      : undefined,
    rating: Number.isFinite(details.vote_average) && details.vote_count > 0 ? Number(details.vote_average).toFixed(1) : undefined,
    cast,
    links: metadataLinks(details, credits, "tv"),
    trailer: trailer ? { id: trailer.key, title: nonEmpty(trailer.name) || "Trailer", site: "YouTube" } : undefined,
  });
}

async function getSeriesMetadata(tmdbId) {
  const id = validTmdbId(tmdbId);
  if (!id) return null;
  // Reuse the exact details/credits/images response already fetched for Discover.
  // Only trailers need a separate request; the shared request cache deduplicates it
  // when another detail request for the same series is already in progress.
  const [details, videos] = await Promise.all([
    request("/tv/" + id + SERIES_DETAILS_QUERY),
    request("/tv/" + id + "/videos?language=en-GB"),
  ]);
  return mapSeriesMetadata(details, details?.aggregate_credits, videos, details?.images);
}

function mapSeasonEpisodes(data, season) {
  if (!data || !Array.isArray(data.episodes)) return null;
  return data.episodes.map(episode => ({
    season: Number.isSafeInteger(episode.season_number) ? episode.season_number : season,
    episode: Number.isSafeInteger(episode.episode_number) ? episode.episode_number : undefined,
    title: nonEmpty(episode.name),
    description: nonEmpty(episode.overview),
    thumbnail: imageUrl(episode.still_path, "w500"),
    released: nonEmpty(episode.air_date),
    runtime: Number.isFinite(episode.runtime) && episode.runtime > 0 ? episode.runtime + " min" : undefined,
    rating: Number.isFinite(episode.vote_average) && episode.vote_count > 0 ? Number(episode.vote_average).toFixed(1) : undefined,
    guestStars: uniqueNames(episode.guest_stars, person => person.name, 15),
    directors: uniqueNames(episode.crew, person => /director/i.test(String(person.job || "")) ? person.name : null, 10),
  })).filter(episode => Number.isSafeInteger(episode.episode) && episode.episode > 0);
}

async function getSeasonEpisodes(tmdbId, seasonNumber, options = {}) {
  const id = validTmdbId(tmdbId);
  const season = Number(seasonNumber);
  if (!id || !Number.isSafeInteger(season) || season < 0 || season > 1000) return null;
  const data = await request("/tv/" + id + "/season/" + season + "?language=en-GB", options);
  return mapSeasonEpisodes(data, season);
}

function validSeasonRuntimeSummary(value, now) {
  return value && Number.isSafeInteger(value.season) && value.season >= 0 && value.season <= 1000 &&
    Number.isSafeInteger(value.episodeCount) && value.episodeCount >= 0 &&
    Number.isSafeInteger(value.runtimeCount) && value.runtimeCount >= 0 &&
    Number.isFinite(value.totalMinutes) && value.totalMinutes >= 0 &&
    value.totalMinutes <= value.runtimeCount * 24 * 60 &&
    (value.runtimeCount > 0 ? value.totalMinutes > 0 : value.totalMinutes === 0) &&
    Number.isFinite(value.checkedAt) && value.checkedAt > 0 && value.checkedAt <= now;
}

async function getSeriesRuntimeMetadata(tmdbId, { previous = null, refresh = false } = {}) {
  const id = validTmdbId(tmdbId);
  if (!id || !tmdbConfigured()) return null;
  const pendingKey = id + (refresh ? ":refresh" : ":cached");
  if (runtimePending.has(pendingKey)) return runtimePending.get(pendingKey);
  const task = (async () => {
    // Share the existing series-details response with catalogue/detail requests.
    // Persistent callers retain only the small per-season totals returned below.
    const details = await request("/tv/" + id + SERIES_DETAILS_QUERY, { refresh });
    if (!details || !nonEmpty(details.name)) return null;
    const officialRuntime = Array.isArray(details.episode_run_time)
      ? details.episode_run_time.map(parseRuntimeMinutes).find(value => value !== null) : null;
    if (officialRuntime != null) {
      return { runtime: officialRuntime + " min", source: "tmdb-series", episodeCount: 0, totalMinutes: 0, complete: true, seasons: [] };
    }

    const now = Date.now();
    const priorSeasons = new Map();
    if (previous?.policyVersion === 1 && (!previous?.tmdbId || String(previous.tmdbId) === id) && Array.isArray(previous?.seasons)) {
      for (const summary of previous.seasons) {
        if (validSeasonRuntimeSummary(summary, now)) priorSeasons.set(summary.season, summary);
      }
    }
    const listedSeasons = new Map();
    let validListing = Array.isArray(details.seasons);
    for (const entry of Array.isArray(details.seasons) ? details.seasons : []) {
      const season = entry?.season_number;
      if (season === 0) continue;
      if (!Number.isSafeInteger(season) || season < 0 || season > 1000) {
        validListing = false;
        continue;
      }
      const episodeCount = Number.isSafeInteger(entry.episode_count) && entry.episode_count >= 0
        ? entry.episode_count : null;
      listedSeasons.set(season, { season, episodeCount });
    }
    if (Number(details.number_of_episodes) > 0 && listedSeasons.size === 0) validListing = false;
    const seasons = [...listedSeasons.values()].sort((a, b) => a.season - b.season);
    const summaries = new Array(seasons.length);
    let nextSeason = 0;
    const worker = async () => {
      while (nextSeason < seasons.length) {
        const index = nextSeason++;
        const { season, episodeCount } = seasons[index];
        const saved = priorSeasons.get(season);
        const durationTtl = saved?.runtimeCount >= (saved?.eligibleEpisodeCount ?? saved?.episodeCount)
          ? COMPLETE_SEASON_RUNTIME_TTL_MS : PARTIAL_SEASON_RUNTIME_TTL_MS;
        if (saved?.complete === true && episodeCount !== null && saved.episodeCount === episodeCount &&
            now - saved.checkedAt < durationTtl) {
          summaries[index] = { ...saved };
          continue;
        }
        if (episodeCount === 0) {
          summaries[index] = { season, episodeCount: 0, eligibleEpisodeCount: 0, runtimeCount: 0, totalMinutes: 0, checkedAt: now, complete: true };
          continue;
        }
        // Use the same cached endpoint as getSeasonEpisodes, but do not build
        // thumbnails, credits or full episode metadata for a runtime-only pass.
        const data = await request("/tv/" + id + "/season/" + season + "?language=en-GB", {
          refresh: Boolean(refresh || saved)
        });
        if (!data || !Array.isArray(data.episodes)) {
          summaries[index] = saved ? { ...saved, complete: false } : {
            season, episodeCount: episodeCount ?? 0, runtimeCount: 0,
            totalMinutes: 0, checkedAt: now, complete: false
          };
          continue;
        }
        const episodes = data.episodes.filter(episode => episode && typeof episode === "object" &&
          Number.isSafeInteger(episode.episode_number) && episode.episode_number >= 0);
        const runtimeEpisodes = episodes.map(episode => ({
          id: episode.id,
          season: Number.isSafeInteger(episode.season_number) && episode.season_number >= 0 ? episode.season_number : season,
          episode: episode.episode_number,
          runtime: episode.runtime,
          released: episode.air_date
        })).filter(episode => isEligibleRuntimeEpisode(episode, now));
        const average = averageEpisodeRuntime(runtimeEpisodes);
        const eligibleEpisodeCount = new Set(runtimeEpisodes.map(episode => episode.episode)).size;
        const uniqueEpisodeCount = new Set(episodes.map(episode => episode.episode_number)).size;
        const complete = episodes.length === data.episodes.length &&
          (episodeCount === null || uniqueEpisodeCount >= episodeCount);
        summaries[index] = !complete && saved ? { ...saved, complete: false } : {
          season,
          episodeCount: episodeCount ?? episodes.length,
          eligibleEpisodeCount,
          runtimeCount: average?.episodeCount || 0,
          totalMinutes: average?.totalMinutes || 0,
          checkedAt: now,
          complete
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, seasons.length) }, () => worker()));
    const episodeCount = summaries.reduce((total, summary) => total + summary.runtimeCount, 0);
    const totalMinutes = summaries.reduce((total, summary) => total + summary.totalMinutes, 0);
    return {
      ...(episodeCount ? { runtime: Math.max(1, Math.round(totalMinutes / episodeCount)) + " min" } : {}),
      source: "tmdb-episodes",
      policyVersion: 1,
      episodeCount,
      totalMinutes,
      complete: validListing && summaries.every(summary => summary.complete),
      seasons: summaries
    };
  })();
  runtimePending.set(pendingKey, task);
  try {
    return await task;
  } finally {
    if (runtimePending.get(pendingKey) === task) runtimePending.delete(pendingKey);
  }
}

function stripEmpty(value) {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined || value[key] === null || value[key] === "" ||
        (Array.isArray(value[key]) && value[key].length === 0)) delete value[key];
  }
  return value;
}

module.exports = {
  getMovieMetadata,
  getSeriesMetadata,
  getMovieCatalogMetadata,
  getSeriesCatalogMetadata,
  getSeasonEpisodes,
  getSeriesRuntimeMetadata,
  getDiagnostics,
  mapMovieMetadata,
  mapSeriesMetadata,
  mapSeasonEpisodes,
  validTmdbId,
  tmdbConfigured,
};
