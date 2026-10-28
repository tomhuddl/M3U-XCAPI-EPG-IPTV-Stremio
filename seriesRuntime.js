const MAX_EPISODE_RUNTIME_MINUTES = 24 * 60;

function parseRuntimeMinutes(value) {
    let minutes;
    if (typeof value === "number") {
        minutes = value;
    } else if (typeof value === "string") {
        const text = value.trim();
        const duration = text.match(/^(\d{1,3}):([0-5]\d):([0-5]\d(?:\.\d+)?)$/);
        if (duration) {
            minutes = Number(duration[1]) * 60 + Number(duration[2]) + Number(duration[3]) / 60;
        } else {
            const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|m)?$/i);
            if (!match) return null;
            minutes = Number(match[1]);
        }
    } else {
        return null;
    }
    return Number.isFinite(minutes) && minutes > 0 && minutes <= MAX_EPISODE_RUNTIME_MINUTES
        ? minutes : null;
}

function averageEpisodeRuntime(episodes) {
    if (!Array.isArray(episodes)) return null;
    const seen = new Set();
    let totalMinutes = 0;
    let episodeCount = 0;
    for (let index = 0; index < episodes.length; index++) {
        const episode = episodes[index];
        if (!episode || typeof episode !== "object") continue;
        const minutes = parseRuntimeMinutes(episode.runtimeMinutes) ?? parseRuntimeMinutes(episode.runtime);
        if (minutes === null) continue;
        const season = episode.season == null || episode.season === "" ? NaN : Number(episode.season);
        const number = episode.episode == null || episode.episode === "" ? NaN : Number(episode.episode);
        const id = episode.id ?? episode.stream_id;
        const key = Number.isSafeInteger(season) && season >= 0 && Number.isSafeInteger(number) && number > 0
            ? "episode:" + season + ":" + number
            : (typeof id === "string" && id.trim()) || (typeof id === "number" && Number.isFinite(id))
                ? "id:" + String(id) : "row:" + index;
        if (seen.has(key)) continue;
        seen.add(key);
        totalMinutes += minutes;
        episodeCount++;
    }
    if (!episodeCount) return null;
    return {
        runtime: Math.max(1, Math.round(totalMinutes / episodeCount)) + " min",
        episodeCount,
        totalMinutes
    };
}

// Keep every provider episode in the population, including ones without a
// duration. TMDb may fill their runtime, but must never add episodes to it.
function providerEpisodes(episodes) {
    const unique = new Map();
    for (const [index, episode] of (Array.isArray(episodes) ? episodes : []).entries()) {
        if (!episode || typeof episode !== "object") continue;
        const season = episode.season == null || episode.season === "" ? null : Number(episode.season);
        const number = episode.episode == null || episode.episode === "" ? null : Number(episode.episode);
        const validSeason = Number.isSafeInteger(season) && season >= 0 && season <= 1000 ? season : null;
        const validNumber = Number.isSafeInteger(number) && number > 0 ? number : null;
        const id = String(episode.id ?? episode.stream_id ?? "");
        const key = validSeason !== null && validNumber !== null
            ? "episode:" + validSeason + ":" + validNumber : id ? "id:" + id : "row:" + index;
        const value = { id, season: validSeason, episode: validNumber,
            runtimeMinutes: parseRuntimeMinutes(episode.runtimeMinutes) ?? parseRuntimeMinutes(episode.runtime) };
        const old = unique.get(key);
        if (!old || (old.runtimeMinutes === null && value.runtimeMinutes !== null)) unique.set(key, value);
    }
    return [...unique.values()];
}

function providerEpisodeFingerprint(episodes) {
    const rows = providerEpisodes(episodes).map(episode =>
        [episode.season, episode.episode, episode.id, episode.runtimeMinutes]);
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return require("crypto").createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function averageProviderEpisodes(episodes, seasonResults = []) {
    const listed = providerEpisodes(episodes);
    const matching = new Map();
    const lookedUp = new Set();
    for (const [season, rows] of seasonResults) {
        for (const episode of Array.isArray(rows) ? rows : []) {
            const minutes = parseRuntimeMinutes(episode.runtimeMinutes) ?? parseRuntimeMinutes(episode.runtime);
            const number = Number(episode.episode);
            if (Number.isSafeInteger(number) && number > 0 &&
                (episode.season == null || Number(episode.season) === Number(season))) {
                const key = Number(season) + ":" + number;
                lookedUp.add(key);
                if (minutes !== null) matching.set(key, minutes);
            }
        }
    }
    let tmdbEpisodeCount = 0;
    let providerDurationCount = 0;
    let unresolvedEpisodeCount = 0;
    const resolved = listed.map(episode => {
        const tmdb = episode.season !== null && episode.episode !== null
            ? matching.get(episode.season + ":" + episode.episode) : undefined;
        if (tmdb !== undefined) tmdbEpisodeCount++;
        else if (episode.runtimeMinutes !== null) providerDurationCount++;
        else if (!lookedUp.has(episode.season + ":" + episode.episode)) unresolvedEpisodeCount++;
        return { ...episode, runtimeMinutes: tmdb ?? episode.runtimeMinutes };
    });
    const average = averageEpisodeRuntime(resolved);
    return {
        ...(average || { episodeCount: 0, totalMinutes: 0 }),
        scope: "provider-episodes", episodeFingerprint: providerEpisodeFingerprint(listed),
        providerEpisodeCount: listed.length, tmdbEpisodeCount, providerDurationCount, unresolvedEpisodeCount,
        missingDurationCount: listed.length - (average?.episodeCount || 0),
        source: tmdbEpisodeCount ? (providerDurationCount ? "mixed-episodes" : "tmdb-episodes") : "provider-episodes"
    };
}

module.exports = { parseRuntimeMinutes, averageEpisodeRuntime, providerEpisodes,
    providerEpisodeFingerprint, averageProviderEpisodes };