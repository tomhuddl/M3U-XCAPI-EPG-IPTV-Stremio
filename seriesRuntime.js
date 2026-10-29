const MAX_EPISODE_RUNTIME_MINUTES = 24 * 60;

function isEligibleRuntimeEpisode(episode, now = Date.now()) {
    if (!episode || typeof episode !== "object") return false;
    const rawSeason = episode.season ?? episode.season_number;
    const season = rawSeason == null || rawSeason === "" ? NaN : Number(rawSeason);
    if (!Number.isSafeInteger(season) || season <= 0) return false;
    const released = episode.air_date || episode.released || episode.releasedate;
    if (released == null || released === "") return true;
    const text = String(released).trim();
    const timestamp = /^\d{9,13}$/.test(text)
        ? Number(text) * (text.length <= 10 ? 1000 : 1)
        : Date.parse(text);
    // Unknown dates do not exclude an otherwise usable regular episode.
    return !Number.isFinite(timestamp) || timestamp <= now;
}

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
        if (!isEligibleRuntimeEpisode(episode)) continue;
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

module.exports = { parseRuntimeMinutes, averageEpisodeRuntime, isEligibleRuntimeEpisode };
