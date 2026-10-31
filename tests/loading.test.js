"use strict";
const assert = require("assert");
const path = require("path"), fs = require("fs"), { spawnSync } = require("child_process");
const createAddon = require("../addon"), { M3UEPGAddon } = createAddon;
const tmdb = require("../src/js/tmdbMetadata");
const PersistentCatalogMetaCache = require("../persistentCatalogMetaCache");
const PersistentSeriesInfoCache = require("../persistentSeriesInfoCache");
const { projectResponse } = require("../publicMetadata");
const RequestScheduler = require("../requestScheduler");
const context = require("../requestContext");
const HOUR = 3600000, DAY = 24 * HOUR;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function saved(type = "series", extra = {}) {
    return { id: type === "movie" ? "iptv_vod_2" : "iptv_series_3", type, name: "Saved title",
        _tmdbId: "123", poster: "https://example.com/p.jpg", background: "https://example.com/b.jpg",
        logo: "https://example.com/l.png", description: "Saved description", genres: ["Drama"],
        year: 2026, releaseInfo: "2026", runtime: "60 min", imdbId: "tt1234567", imdbRating: "8.2",
        cast: ["Actor"], director: ["Director"], metadataVersion: 3, imdbIdChecked: true,
        metadataCheckedAt: Date.now(), missingMetadataCheckedAt: Date.now(), omdbCheckedAt: Date.now(), ...extra };
}
function setup(type = "series", value = saved(type)) {
    const addon = new M3UEPGAddon({ provider: "direct", enableEpg: false }); addon.log = quiet;
    addon.lastUpdate = Date.now();
    const item = { id: value.id, type, name: "Provider title", tmdbId: "123", series_id: "3", url: "https://example.com/video.mp4" };
    addon[type === "series" ? "series" : "movies"] = [item];
    const entries = new Map([[item.id, { value: structuredClone(value), savedAt: Date.now() }]]);
    addon.persistentCatalogMetaCache = { entries, init: async () => {}, get: async key => entries.get(key) || null,
        set: async (key, value, valid) => { if (!valid || valid()) entries.set(key, { value, savedAt: Date.now() }); }, flush: async () => {} };
    addon.ensureSeriesInfo = async () => ({ videos: [{ id: "iptv_series_ep_9", season: 1, episode: 1, title: "Episode" }] });
    addon.getDetailOmdbMetadata = async () => ({ imdbId: value.imdbId, imdbRating: value.imdbRating });
    return { addon, item, entries, value };
}
async function mock(target, replacements, run) {
    const old = Object.fromEntries(Object.keys(replacements).map(key => [key, target[key]])); Object.assign(target, replacements);
    try { return await run(); } finally { Object.assign(target, old); }
}
function probe(mode) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/loadingProbe.js"), mode], {
        encoding: "utf8", timeout: 15000, cwd: path.resolve(__dirname, ".."), env: process.env });
    assert.strictEqual(result.status, 0, result.stderr + "\n" + result.stdout);
}
async function testLoadingPublicMetadataOmitsOnlyInternalAndUnusedEpisodeFields() {
    const value = saved();
    value.runtimeAverage = { version: 1, policyVersion: 1, runtime: "60 min" };
    value._detailExtras = { checkedAt: Date.now() };
    value.links = [{ name: "Actor", category: "Cast", url: "https://example.com/actor" },
        { name: "Writer", category: "Writers", url: "https://example.com/writer" }];
    value.videos = [{ id: "ep", title: "Episode", season: 1, episode: 1, overview: "Overview",
        runtime: "60 min", cast: ["Guest"], directors: ["Director"], links: [] }];
    const original = structuredClone(value);
    const win = projectResponse({ meta: value }, { ios: false }).meta;
    const ios = projectResponse({ meta: value }, { ios: true }).meta;
    for (const field of ["metadataVersion", "runtimeAverage", "_tmdbId", "imdbIdChecked", "omdbCheckedAt", "_detailExtras"])
        assert.strictEqual(win[field], undefined, field);
    for (const field of ["name", "description", "runtime", "cast", "director", "year", "releaseInfo", "logo"])
        assert.deepStrictEqual(win[field], value[field], field);
    assert.strictEqual(win.links.length, 1); assert.strictEqual(ios.links.length, 2);
    for (const key of ["cast", "directors", "runtime", "links"]) assert.strictEqual(win.videos[0][key], undefined);
    assert.strictEqual(win.videos[0].overview, "Overview");
    assert.deepStrictEqual(value, original, "projection must not mutate stored data or another platform's response");
}
async function testLoadingLiveLabelRemovedButEpgDurationsAndCreditsPreserved() {
    const body = { metasDetailed: [{ id: "live", type: "tv", name: "Live", runtime: "Live", poster: "logo/channel.one.png",
        behaviorHints: { isLive: true, hasScheduledVideos: true }, videos: [{ id: "programme", title: "Show",
            startTime: "2026-10-31T10:00:00Z", endTime: "2026-10-31T11:00:00Z", runtime: "60 min", cast: ["Actor"], directors: ["Director"] }] }] };
    const out = projectResponse(body, { origin: "https://addon.example", token: "enc:test" }).metasDetailed[0];
    assert.strictEqual(out.runtime, undefined); assert.strictEqual(out.videos[0].runtime, "60 min");
    assert.deepStrictEqual(out.videos[0].cast, ["Actor"]); assert.deepStrictEqual(out.behaviorHints, body.metasDetailed[0].behaviorHints);
    assert.strictEqual(new URL(out.poster).origin, "https://addon.example");
    const channel = new M3UEPGAddon().generateMetaPreview({ id: "live", type: "tv", name: "Live", attributes: {} });
    assert.strictEqual(channel.runtime, undefined);
}
async function testLoadingLocalFallbackLogoIsCachedPngWithValidDimensions() {
    const render = require("../fallbackLogo"), zlib = require("zlib");
    const png = render("Sky News");
    assert.strictEqual(render("Sky News"), png);
    assert.strictEqual(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.strictEqual(png.readUInt32BE(16), 300); assert.strictEqual(png.readUInt32BE(20), 400);
    const chunks = []; let at = 8;
    while (at < png.length) { const size = png.readUInt32BE(at);
        if (png.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + size));
        at += 12 + size;
    }
    const pixels = zlib.inflateSync(Buffer.concat(chunks));
    assert.strictEqual(pixels.length, (300 * 4 + 1) * 400);
    assert.ok(pixels.some((value, index) => index % (300 * 4 + 1) !== 0 && value === 51));
    assert.ok(pixels.subarray(189 * 1201, 210 * 1201).some(value => value === 255));
}
async function testLoadingSearchRepeatedTokensRemainFastAndRankingUnchanged() {
    const start = performance.now();
    assert.strictEqual(createAddon.matchesNormalizedSearchText("a ".repeat(14) + "b", "a ".repeat(15).trim()), false);
    assert.ok(performance.now() - start < 500);
    const vocabulary = ["a", "ab", "abc", "b"];
    function brute(query, title, used = new Set(), index = 0) {
        if (index === query.length) return true;
        for (let n = 0; n < title.length; n++) if (!used.has(n) && title[n].startsWith(query[index])) {
            used.add(n); if (brute(query, title, used, index + 1)) return true; used.delete(n);
        }
        return false;
    }
    for (const a of vocabulary) for (const b of vocabulary) for (const c of vocabulary) for (const d of vocabulary) {
        const query = [a, b], title = [c, d];
        const expected = title.join(" ").includes(query.join(" ")) || brute(query, title);
        assert.strictEqual(createAddon.matchesNormalizedSearchText(query.join(" "), title.join(" ")), expected);
    }
    assert.strictEqual(createAddon.matchesSearchText("Schitts Creek", "Schitt’s Creek"), true);
    assert.strictEqual(createAddon.matchesSearchText("Schitts Crek", "Schitt’s Creek"), false);
}
async function testLoadingSavedDetailsRemainCompleteOnSourceFailure() {
    for (const type of ["movie", "series"]) {
        const { addon, item, value } = setup(type);
        await mock(tmdb, { [type === "movie" ? "getMovieMetadata" : "getSeriesMetadata"]: async () => null }, async () => {
            const result = await addon.getDetailedMetaAsync(item.id, type);
            for (const field of ["name", "description", "poster", "cast", "runtime", "year"])
                assert.deepStrictEqual(result[field], value[field], field);
            if (type === "series") assert.strictEqual(result.videos.length, 1);
        });
    }
}
async function testLoadingDetailsCoalesceCacheAndInvalidateWhenFieldsChange() {
    const { addon, item, value } = setup("movie"); let calls = 0;
    await mock(tmdb, { getMovieMetadata: async () => { calls++; await tick(); return value; } }, async () => {
        const [a, b] = await Promise.all([addon.getDetailedMetaAsync(item.id, "movie"), addon.getDetailedMetaAsync(item.id, "movie")]);
        assert.strictEqual(calls, 1); assert.deepStrictEqual(a, b);
        a.cast.push("Client mutation"); assert.strictEqual(b.cast.length, 1);
        await addon.getDetailedMetaAsync(item.id, "movie"); assert.strictEqual(calls, 1);
        addon.cacheCatalogMetaPreview(item.id, { ...value, description: "Background update" });
        await addon.getDetailedMetaAsync(item.id, "movie"); assert.strictEqual(calls, 2);
    });
}
async function testLoadingSavedMovieIdReusedWhileFreshButStillRefreshesNormally() {
    const { addon, item, entries } = setup("movie"); let requests = 0;
    delete item.tmdbId; addon.providerName = "xtream";
    const provider = { fetchMovieInfo: async () => { requests++; return { tmdbId: "456" }; } };
    assert.strictEqual(await addon.resolveMovieTmdbId(item.id, item, provider), "123");
    assert.strictEqual(requests, 0);
    entries.get(item.id).value.metadataCheckedAt -= 15 * DAY;
    addon.seriesInfoCache.delete("movie-tmdb:" + item.id);
    assert.strictEqual(await addon.resolveMovieTmdbId(item.id, item, provider), "456");
    assert.strictEqual(requests, 1);
}
async function testLoadingDetailsRebuildIfProviderGenerationChanges() {
    const { addon, item, value } = setup(); const started = deferred(), release = deferred(); let calls = 0;
    addon.ensureSeriesInfo = async () => { calls++; if (calls === 1) { started.resolve(); await release.promise; return null; }
        return { videos: [{ id: "episode", season: 1, episode: 1 }] }; };
    await mock(tmdb, { getSeriesMetadata: async () => value, getSeasonEpisodes: async () => [] }, async () => {
        const pending = addon.getDetailedMetaAsync(item.id, "series"); await started.promise;
        addon.lastUpdate++; addon.series = addon.series.map(series => ({ ...series })); release.resolve();
        const result = await pending; assert.strictEqual(result.videos.length, 1); assert.strictEqual(calls, 2);
    });
}
async function testLoadingRemovedTitleCannotReturnOldDetails() {
    const { addon, item, value } = setup("movie"); const release = deferred(), start = deferred();
    await mock(tmdb, { getMovieMetadata: async () => { start.resolve(); await release.promise; return value; } }, async () => {
        const pending = addon.getDetailedMetaAsync(item.id, "movie"); await start.promise;
        addon.movies = []; addon.lastUpdate++; release.resolve(); assert.strictEqual(await pending, null);
    });
}
async function testLoadingOmdbStartsBeforeSlowProviderEpisodeListCompletes() {
    const { addon, item, value } = setup(); const gate = deferred(); let started = false;
    addon.ensureSeriesInfo = async () => { await gate.promise; return { videos: [] }; };
    addon.getDetailOmdbMetadata = async () => { started = true; return {}; };
    await mock(tmdb, { getSeriesMetadata: async () => value }, async () => {
        const pending = addon.buildSeriesMeta(item); await tick();
        assert.strictEqual(started, true, "independent rating lookup must not wait for provider episodes");
        gate.resolve(); await pending;
    });
}
async function testLoadingPersistentPruningIsBatchedAndStillEnforcesLimits() {
    const cache = new PersistentCatalogMetaCache("prune-test", { directory: "", maxEntries: 100 });
    cache.enabled = true; cache.init = async () => {}; cache.scheduleWrite = () => {}; cache.journal = { mark() {} };
    let calls = 0; const prune = cache.prune; cache.prune = function () { calls++; return prune.call(this); };
    for (let n = 0; n < 50; n++) await cache.set(String(n), { description: "Title " + n });
    assert.strictEqual(calls, 1);
    for (let n = 50; n < 110; n++) await cache.set(String(n), { description: "Title " + n });
    assert.strictEqual(cache.entries.size, 100);
    cache.entries.set("expired", { savedAt: Date.now() - cache.staleRetentionMs - 1, value: {} });
    cache.nextPruneAt = 0; await cache.set("next", { description: "Next" });
    assert.strictEqual(cache.entries.has("expired"), false);
}
async function testLoadingSchedulerPrioritizesForegroundAndReservesCapacity() {
    const scheduler = new RequestScheduler({ limit: 3, backgroundLimit: 1, maxQueued: 10 });
    const first = await scheduler.acquire("origin", "background"); let backgroundStarted = false;
    const low = scheduler.acquire("origin", "background").then(release => { backgroundStarted = true; return release; });
    const foreground = await scheduler.acquire("origin"); assert.strictEqual(backgroundStarted, false);
    foreground(); first(); const second = await low; second(); assert.strictEqual(scheduler.origins.size, 0);
    const held = await scheduler.acquire("origin"); held(); held(); assert.strictEqual(scheduler.origins.size, 0);
}
async function testLoadingSourcePriorityContextDoesNotLeakToOtherRequests() {
    await context.run({ priority: "foreground", ios: true }, async () => {
        await context.background(async () => { await tick(); assert.strictEqual(context.current().priority, "background"); });
        assert.strictEqual(context.current().ios, true);
    });
    assert.strictEqual(context.current().ios, undefined);
}
async function testLoadingSavedEpisodeMetadataDoesNotRenewProviderClock() {
    const cache = new PersistentSeriesInfoCache("episode-test", { directory: "" });
    let writes = 0;
    cache.enabled = true; cache.init = async () => {}; cache.scheduleWrite = () => {}; cache.journal = { mark() { writes++; } };
    const oldTime = Date.now() - HOUR;
    cache.entries.set("3", { savedAt: oldTime, providerLastUpdate: 123, value: { videos: [{ id: "episode" }] } });
    await cache.updateEnrichment("3", { tmdbId: "123", checkedAt: Date.now(), seasons: [] }, 123);
    assert.strictEqual(cache.entries.get("3").savedAt, oldTime);
    const old = cache.entries.get("3").value._episodeMetadata;
    await cache.updateEnrichment("3", { ...old, checkedAt: Date.now() + 1 }, 123);
    assert.strictEqual(writes, 1, "reusing unchanged seasons must not journal the full series entry again");
    await cache.updateEnrichment("3", { tmdbId: "wrong" }, 122);
    assert.strictEqual(cache.entries.get("3").value._episodeMetadata, old);
}
async function testLoadingFreshEpisodeMetadataAvoidsRepeatSeasonRequests() {
    const { addon, item } = setup(); let calls = 0;
    const episodes = [{ season: 1, episode: 1, title: "Saved episode", runtime: "50 min" }];
    const info = { videos: [{ season: 1, episode: 1 }], _episodeMetadata: { tmdbId: "123", checkedAt: Date.now(),
        seasons: [{ season: 1, checkedAt: Date.now(), episodes }] } };
    await mock(tmdb, { getSeasonEpisodes: async () => { calls++; return episodes; } }, async () => {
        assert.deepStrictEqual((await addon.loadSeasonMetadata(item, info, 1)).slice(0, 2), [1, episodes]); assert.strictEqual(calls, 0);
        info.videos.push({ season: 1, episode: 2 }); await addon.loadSeasonMetadata(item, info, 1); assert.strictEqual(calls, 1);
        info.videos.pop(); info._episodeMetadata.seasons[0].checkedAt -= 15 * DAY;
        await addon.loadSeasonMetadata(item, info, 1); assert.strictEqual(calls, 2);
    });
}
async function testLoadingFailedSeasonRefreshRetainsMetadataAndBacksOff() {
    const { addon, item } = setup(); let calls = 0;
    const now = Date.now();
    const old = { season: 1, checkedAt: now - 15 * DAY, episodes: [{ episode: 1, title: "Saved episode", description: "Saved overview" }] };
    const info = { videos: [{ season: 1, episode: 1 }], _episodeMetadata: { tmdbId: "123", seasons: [old] } };
    await mock(tmdb, { getSeasonEpisodes: async () => { calls++; return null; } }, async () => {
        const first = await addon.loadSeasonMetadata(item, info, 1);
        assert.strictEqual(first[1][0].description, "Saved overview");
        assert.strictEqual(first[2].checkedAt, old.checkedAt);
        assert.strictEqual(first[2].retryPending, true);
        info._episodeMetadata.seasons = [first[2]];
        await addon.loadSeasonMetadata(item, info, 1); assert.strictEqual(calls, 1);
        first[2].attemptedAt -= 12 * HOUR + 1;
        await addon.loadSeasonMetadata(item, info, 1); assert.strictEqual(calls, 2);
    });
}
async function testLoadingAbandonedCatalogueStopsStartingUnsharedItems() {
    const { addon, item, value } = setup("movie");
    addon.movies = Array.from({ length: 5 }, (_, n) => ({ ...item, id: "iptv_vod_" + n }));
    const controller = new AbortController(); let calls = 0;
    addon.getCatalogMetaAsync = async id => { calls++; controller.abort(); return { ...value, id }; };
    await assert.rejects(() => context.run({ signal: controller.signal }, () => addon.enrichCatalogMetaItems(addon.movies, 1)),
        error => error.name === "AbortError");
    assert.strictEqual(calls, 1);
}
async function testLoadingEpgResponseCacheTracksGuideAndCatalogueChanges() {
    const proto = M3UEPGAddon.prototype;
    let live, calls = 0;
    const methods = ["loadFromCache", "updateData", "startConfiguredCatalogPrefetch", "startScheduledRefresh"];
    const original = Object.fromEntries(methods.map(key => [key, proto[key]]));
    proto.loadFromCache = async function () {
        live = this; this.lastUpdate = Date.now(); this.log = quiet;
        this.channels = [{ id: "iptv_live_1", type: "tv", name: "Channel", attributes: { "tvg-id": "one" } }];
        this.epgData = { one: [{ title: "Old programme", start: "20261031100000 +0000", stop: "20261031110000 +0000" }] };
        this.persistentCatalogMetaCache = { entries: new Map(), init: async () => {}, flush: async () => {} };
        const get = this.getScheduledPrograms;
        this.getScheduledPrograms = (...args) => { calls++; return get.apply(this, args); };
    };
    proto.updateData = async () => {};
    proto.startConfiguredCatalogPrefetch = proto.startScheduledRefresh = () => {};
    let iface;
    try {
        iface = await createAddon({ provider: "direct", m3uUrl: "https://example.com/epg-loading-test.m3u", enableEpg: true });
        const read = () => iface.get("catalog", "tv", "iptv_channels", { date: "2026-10-31" });
        const old = await read(); await read(); assert.strictEqual(calls, 1);
        assert.strictEqual(old.metasDetailed[0].videos[0].runtime, "60 min");
        live.epgData = { one: [{ ...live.epgData.one[0], title: "New programme" }] };
        const refreshed = await read(); assert.strictEqual(calls, 2);
        assert.strictEqual(refreshed.metasDetailed[0].videos[0].title, "New programme");
        live.lastUpdate++; live.channels = [{ ...live.channels[0], name: "Renamed channel" }];
        assert.strictEqual((await read()).metasDetailed[0].name, "Renamed channel"); assert.strictEqual(calls, 3);
    } finally { if (iface) await createAddon.disposeAddonInterface(iface); Object.assign(proto, original); }
}
async function testLoadingHttpBuildsWritersProjectionCompressionAndRouterReuse() { probe("http"); }
async function testLoadingApiStagesAndFullRefreshUseOneDetailsRequest() { probe("api"); }
async function testLoadingSavedStartupDoesNotWaitForProviderAndErrorsAreHandled() { probe("startup"); }

module.exports = [testLoadingPublicMetadataOmitsOnlyInternalAndUnusedEpisodeFields,
    testLoadingLocalFallbackLogoIsCachedPngWithValidDimensions,
    testLoadingLiveLabelRemovedButEpgDurationsAndCreditsPreserved, testLoadingSearchRepeatedTokensRemainFastAndRankingUnchanged,
    testLoadingSavedDetailsRemainCompleteOnSourceFailure, testLoadingDetailsCoalesceCacheAndInvalidateWhenFieldsChange,
    testLoadingSavedMovieIdReusedWhileFreshButStillRefreshesNormally,
    testLoadingDetailsRebuildIfProviderGenerationChanges, testLoadingRemovedTitleCannotReturnOldDetails,
    testLoadingOmdbStartsBeforeSlowProviderEpisodeListCompletes,
    testLoadingPersistentPruningIsBatchedAndStillEnforcesLimits, testLoadingSchedulerPrioritizesForegroundAndReservesCapacity,
    testLoadingSourcePriorityContextDoesNotLeakToOtherRequests, testLoadingSavedEpisodeMetadataDoesNotRenewProviderClock,
    testLoadingFreshEpisodeMetadataAvoidsRepeatSeasonRequests, testLoadingHttpBuildsWritersProjectionCompressionAndRouterReuse,
    testLoadingFailedSeasonRefreshRetainsMetadataAndBacksOff,
    testLoadingAbandonedCatalogueStopsStartingUnsharedItems, testLoadingEpgResponseCacheTracksGuideAndCatalogueChanges,
    testLoadingApiStagesAndFullRefreshUseOneDetailsRequest, testLoadingSavedStartupDoesNotWaitForProviderAndErrorsAreHandled];
