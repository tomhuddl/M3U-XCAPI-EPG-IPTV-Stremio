"use strict";
const META_FIELDS = ["id", "type", "name", "poster", "posterShape", "background", "logo", "description", "genres",
    "releaseInfo", "year", "released", "runtime", "imdbId", "imdb_id", "imdbRating", "cast", "director", "trailers", "links", "behaviorHints"];
const VIDEO_FIELDS = ["id", "title", "season", "episode", "released", "thumbnail", "overview", "available", "streams", "trailers"];
const EPG_FIELDS = ["startTime", "endTime", "runtime", "releaseInfo", "genres", "cast", "directors", "links", "ratings"];
function pick(value, fields) {
    const result = {};
    for (const key of fields) if (value[key] !== undefined && value[key] !== null)
        result[key] = typeof value[key] === "object" ? structuredClone(value[key]) : value[key];
    return result;
}
function projectMeta(meta, context = {}) {
    if (!meta || typeof meta !== "object") return meta;
    const out = pick(meta, META_FIELDS);
    if (out.type === "tv") delete out.runtime;
    if (typeof out.poster === "string" && out.poster.startsWith("logo/")) {
        out.poster = context.origin && context.token
            ? context.origin + "/" + encodeURIComponent(context.token) + "/" + out.poster
            : "https://via.placeholder.com/300x400/333333/FFFFFF?text=" + encodeURIComponent(out.name || "Live TV");
    }
    if (Array.isArray(out.links)) out.links = out.links.filter(link =>
        link && !(link.category === "Writers" && !context.ios) && !(link.category === "Rating" && context.ios));
    if (Array.isArray(meta.videos)) out.videos = meta.videos.map(video => {
        const scheduled = meta.type === "tv" && video.startTime && video.endTime;
        return pick(video, scheduled ? [...VIDEO_FIELDS, ...EPG_FIELDS] : VIDEO_FIELDS);
    });
    return out;
}
function projectResponse(body, context) {
    if (!body || typeof body !== "object") return body;
    const out = { ...body };
    if (body.meta) out.meta = projectMeta(body.meta, context);
    if (Array.isArray(body.metas)) out.metas = body.metas.map(meta => projectMeta(meta, context));
    if (Array.isArray(body.metasDetailed)) out.metasDetailed = body.metasDetailed.map(meta => projectMeta(meta, context));
    return out;
}
module.exports = { projectMeta, projectResponse };

