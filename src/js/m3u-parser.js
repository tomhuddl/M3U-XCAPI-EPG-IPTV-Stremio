(function (root, factory) {
    if (typeof module === "object" && module.exports)
        module.exports = factory();
    else root.M3UParser = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";
    const compactEpisode = /\bS(\d{1,3})E(\d{1,4})\b/i;
    const namedEpisode = /\bSeason\s?(\d{1,3}).*?\bEp(?:isode)?\s?(\d{1,4})\b/i;

    function extractSeasonEpisode(title) {
        const match =
            String(title || "").match(compactEpisode) ||
            String(title || "").match(namedEpisode);
        return match
            ? { season: Number(match[1]), episode: Number(match[2]) }
            : null;
    }
    function baseSeriesName(title) {
        const text = String(title || "");
        const marker = text.search(compactEpisode);
        const start = marker < 0 ? text.search(/\bSeason\s?\d+/i) : marker;
        let name = (start < 0 ? text : text.slice(0, start))
            .replace(/[-._\s]+$/, "")
            .trim();
        const quality =
            start >= 0 &&
            text
                .slice(start)
                .match(/(?:^|\s|\[|\()(4K|UHD|FHD|HD|SD)[\])]?\s*$/i);
        if (quality && !new RegExp("\\b" + quality[1] + "$", "i").test(name))
            name += " " + quality[1];
        return name;
    }
    function parseAttributes(text) {
        const attributes = {};
        const pattern = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let match;
        while ((match = pattern.exec(text))) {
            Object.defineProperty(attributes, match[1].toLowerCase(), {
                value: match[2] ?? match[3],
                enumerable: true,
                configurable: true,
                writable: true
            });
        }
        return attributes;
    }
    function parseExtinf(line) {
        const duration = line.match(/^#EXTINF:([+-]?\d+(?:\.\d+)?)(?=\s|,)/i);
        if (!duration) return null;
        let quote = null;
        for (let i = duration[0].length; i < line.length; i++) {
            const char = line[i];
            if (quote) {
                if (char === quote && line[i - 1] !== "\\") quote = null;
            } else if (char === '"' || char === "'") quote = char;
            else if (char === ",")
                return {
                    duration: Number(duration[1]),
                    attributes: parseAttributes(
                        line.slice(duration[0].length, i)
                    ),
                    name: line.slice(i + 1).trim()
                };
        }
        return null;
    }
    function classify(item) {
        const group = String(
            item.attributes["group-title"] || ""
        ).toLowerCase();
        if (
            extractSeasonEpisode(item.name) ||
            /\bseason\s?\d+/i.test(item.name)
        )
            return "series";
        if (/\b(?:series|shows?)\b/.test(group)) return "series";
        if (/\b(?:movies?|vod|films?)\b/.test(group)) return "movie";
        if (
            /\b(?:live|tv|channels?|news|sports?|entertainment|music)\b/.test(
                group
            )
        )
            return "tv";
        return /\(\d{4}\)|\bmovie\b|\b\d{4}\./i.test(item.name)
            ? "movie"
            : "tv";
    }
    function parseM3U(content) {
        const items = [];
        let current = null;
        for (const raw of String(content || "").split(/\r?\n/)) {
            const line = raw.trim();
            if (/^#EXTINF:/i.test(line)) current = parseExtinf(line);
            else if (current && line && !line.startsWith("#")) {
                const attributes = current.attributes;
                items.push({
                    ...current,
                    url: line,
                    type: classify(current),
                    logo: attributes["tvg-logo"],
                    category: attributes["group-title"],
                    epg_channel_id:
                        attributes["tvg-id"] || attributes["tvg-name"]
                });
                current = null;
            }
        }
        return items;
    }
    return { parseM3U, parseAttributes, baseSeriesName, extractSeasonEpisode };
});
