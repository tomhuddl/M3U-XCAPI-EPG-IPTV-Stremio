const assert = require("assert");
const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const { Readable } = require("stream");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const createAddon = require("../addon");
const { M3UEPGAddon } = createAddon;
const tmdb = require("../src/js/tmdbMetadata");
const omdb = require("../src/js/omdbMetadata");
const PersistentCatalogMetaCache = require("../persistentCatalogMetaCache");
const PersistentSeriesInfoCache = require("../persistentSeriesInfoCache");
const PersistentAddonDataCache = require("../persistentAddonDataCache");
const HOUR = 3600000, DAY = 24 * HOUR;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function withClock(run) {
    const original = Date.now;
    let now = original();
    Date.now = () => now;
    try { return await run({ now: () => now, advance: ms => { now += ms; }, set: time => { now = time; } }); }
    finally { Date.now = original; }
}
function preview(overrides = {}) {
    return { id: "iptv_series_3", type: "series", name: "Example", _tmdbId: "123",
        poster: "https://example.com/p.jpg", background: "https://example.com/b.jpg",
        description: "Complete description", genres: ["Drama"], year: 2026, runtime: "60 min",
        imdbId: "tt1234567", imdbRating: "8.0", cast: ["Actor"], metadataVersion: 3,
        imdbIdChecked: true, omdbChecked: true, omdbCheckedAt: Date.now(),
        metadataCheckedAt: Date.now(), missingMetadataCheckedAt: Date.now(), ...overrides };
}
function store(values = []) {
    const entries = new Map(values.map(value => [value.id, { value: structuredClone(value), savedAt: Date.now() }]));
    return { entries, init: async () => {},
        get: async key => entries.get(String(key)) || null,
        set: async (key, value, current) => {
            if (!current || current()) entries.set(String(key), { value: structuredClone(value), savedAt: Date.now() });
        },
        delete: async key => entries.delete(String(key)),
        retainCatalogItems: async ids => {
            for (const key of entries.keys()) if (!key.startsWith("__") && !ids.has(key)) entries.delete(key);
        }, flush: async () => {} };
}
function seriesStore() {
    const cache = new PersistentSeriesInfoCache("refresh-fix-tests", { directory: "" });
    cache.enabled = true;
    cache.init = async () => {};
    cache.journal = { mark() {}, forceCompact: false };
    cache.scheduleWrite = () => {};
    cache.flush = async () => {};
    return cache;
}
function addon(tag, value = preview(), provider = "direct") {
    const instance = new M3UEPGAddon({ provider, m3uUrl: "https://example.com/audit-fix-" + tag + ".m3u",
        xtreamUrl: "https://example.com/" + tag, xtreamUsername: "test", xtreamPassword: "test", enableEpg: false });
    instance.log = quiet;
    instance.lastUpdate = Date.now() - 13 * HOUR;
    instance.channels = [{ id: "iptv_live_1", type: "tv", name: "Channel", attributes: { "tvg-id": "channel.one" } }];
    instance.movies = [];
    instance.series = [{ id: "iptv_series_3", series_id: "3", type: "series", name: "Example", tmdbId: "123" }];
    instance.persistentCatalogMetaCache = store(value ? [value] : []);
    instance.persistentSeriesInfoCache = seriesStore();
    instance.persistentAddonDataCache = { flush: async () => {}, save: async () => true };
    instance.snapshots = [];
    instance.saveToCache = async () => { instance.snapshots.push(structuredClone(instance.providerSnapshot())); };
    return instance;
}
function fill(target, source, overrides = {}) {
    Object.assign(target, {
        channels: source.channels.map(item => ({ ...item })), movies: source.movies.map(item => ({ ...item })),
        series: source.series.map(item => ({ ...item })), epgData: source.epgData
    }, overrides);
}
async function mockMethods(target, replacements, run) {
    const original = Object.fromEntries(Object.keys(replacements).map(key => [key, target[key]]));
    Object.assign(target, replacements);
    try { return await run(); } finally { Object.assign(target, original); }
}
async function withProviderFetch(name, fetch, run) {
    const safety = require("../urlSafety"), modulePath = require.resolve("../src/js/providers/" + name + "Provider");
    const originalFetch = safety.safeFetch, originalModule = require.cache[modulePath];
    safety.safeFetch = fetch;
    delete require.cache[modulePath];
    try { return await run(require(modulePath)); }
    finally {
        safety.safeFetch = originalFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
    }
}
async function settle(instance) {
    while (instance.catalogMetaPersistWrites.size) await Promise.allSettled([...instance.catalogMetaPersistWrites]);
}
const episode = (id = "9") => ({ id: "iptv_series_ep_" + id, title: "Episode", season: 1, episode: 1,
    url: "https://example.com/series/" + id + ".mp4" });

async function testOpenXtreamSeriesRemainsPlayableAfterProviderRefresh() {
    const instance = addon("playback-refresh", preview(), "xtream");
    const video = episode();
    instance.cacheSeriesInfo("3", { videos: [video] });
    const provider = require("../src/js/providers/xtreamProvider");
    await mockMethods(provider, { fetchData: async target => fill(target, instance) }, async () => {
        assert.ok(instance.getStream(video.id)?.url);
        await instance.updateData();
        assert.strictEqual(instance.seriesInfoCache.has("3"), false, "the next detail open must check the new provider generation");
        assert.strictEqual((await instance.getStreamAsync(video.id)).url, video.url,
            "an already-open page must retain its working stream lookup");
    });
}

async function testRemovedAndReplacedSeriesLoseOldStreamMappings() {
    const instance = addon("playback-invalidation", preview(), "xtream"), first = episode("9"), removed = episode("10");
    instance.series.push({ id: "iptv_series_4", series_id: "4", type: "series", name: "Removed", tmdbId: "456" });
    await instance.persistentSeriesInfoCache.set("3", { videos: [first] }, instance.lastUpdate);
    await instance.persistentSeriesInfoCache.set("4", { videos: [removed] }, instance.lastUpdate);
    instance.cacheSeriesInfo("3", { videos: [first] });
    instance.cacheSeriesInfo("4", { videos: [removed] });
    const provider = require("../src/js/providers/xtreamProvider");
    await mockMethods(provider, {
        fetchData: async target => fill(target, instance, { series: [{ ...instance.series[0], tmdbId: "999", name: "Replacement" }] }),
        fetchSeriesInfo: async () => { throw new Error("Old episode IDs must not query a replacement series"); }
    }, async () => {
        await instance.updateData();
        assert.strictEqual(await instance.getStreamAsync(first.id), null);
        assert.strictEqual(await instance.getStreamAsync(removed.id), null);
        assert.strictEqual(instance.persistentSeriesInfoCache.entries.size, 0);
    });
}

async function testEpisodeStreamsRecoverFromVolumeWithoutProviderRequests() {
    await withClock(async clock => {
        const instance = addon("playback-volume", preview(), "xtream"), video = episode();
        await instance.persistentSeriesInfoCache.set("3", { videos: [video] }, instance.lastUpdate);
        const provider = require("../src/js/providers/xtreamProvider");
        await mockMethods(provider, { fetchSeriesInfo: async () => { throw new Error("Fresh volume details must be reused"); } }, async () => {
            assert.strictEqual((await instance.getStreamAsync(video.id)).url, video.url);
            instance.cacheSeriesInfo("3", { videos: [video] }, 1);
            clock.advance(2);
            assert.strictEqual((await instance.getStreamAsync(video.id)).url, video.url,
                "expiry of the memory mapping must recover the persisted series, without a bulk scan request");
        });
    });
}

async function testPersistentEpisodeIndexTracksChangesAndRetention() {
    await withClock(async clock => {
        const cache = seriesStore(), old = episode("9"), fresh = episode("10");
        await cache.set("3", { videos: [old] }, 1000);
        assert.strictEqual(await cache.findSeriesByEpisodeId(old.id), "3");
        await cache.set("3", { videos: [fresh] }, 1000);
        assert.strictEqual(await cache.findSeriesByEpisodeId(old.id), null);
        assert.strictEqual(await cache.findSeriesByEpisodeId(fresh.id), "3");
        await cache.retainSeries(new Set());
        assert.strictEqual(await cache.findSeriesByEpisodeId(fresh.id), null);
        await cache.set("3", { videos: [old] }, 1000);
        assert.strictEqual(await cache.findSeriesByEpisodeId(old.id), "3");
        clock.advance(cache.staleRetentionMs + 1);
        assert.strictEqual(await cache.findSeriesByEpisodeId(old.id), null);
    });
}

async function testMalformedSuccessfulSeriesResponsesPreserveSavedEpisodes() {
    const payloads = [
        { user_info: { auth: 0 } }, { info: {}, episodes: "invalid" },
        { info: {}, episodes: { "1": {} } }, { episodes: { "1": [{ episode_num: 1 }] } },
        { episodes: { "1": [{ id: 9, season: -1, episode_num: 1 }] } },
        { episodes: { "1": [{ id: 9, season: 1, episode_num: "bad" }] } }
    ];
    for (const payload of payloads) {
        let calls = 0;
        await withProviderFetch("xtream", async () => { calls++; return { ok: true, status: 200, json: async () => payload }; }, async () => {
            const instance = addon("malformed-info-" + payloads.indexOf(payload), preview(), "xtream");
            const saved = { videos: [episode()], fetchedAt: Date.now() - DAY };
            await instance.persistentSeriesInfoCache.set("3", saved, instance.lastUpdate - 1);
            const result = await instance.ensureSeriesInfo("3");
            assert.deepStrictEqual(result.videos, saved.videos);
            assert.strictEqual(instance.persistentSeriesInfoCache.entries.get("3").value, saved);
            await instance.ensureSeriesInfo("3");
            assert.strictEqual(calls, 1, "a failed individual lookup retains the short per-record retry cache");
        });
    }
    for (const episodes of [{}, [], [[], [{ id: 9, season: 1, episode_num: 1 }]]]) {
        await withProviderFetch("xtream", async () => ({ ok: true, status: 200, json: async () => ({ episodes }) }), async provider => {
            const result = await provider.fetchSeriesInfo(addon("valid-empty", null, "xtream"), "3");
            assert.ok(!result.fetchError, "structurally valid empty and array-group listings remain supported");
        });
    }
}

async function testCataloguePagesRebuildAcrossRefreshIncludingNewItems() {
    const proto = M3UEPGAddon.prototype;
    const methods = ["loadFromCache", "updateData", "startConfiguredCatalogPrefetch", "startScheduledRefresh"];
    for (const type of ["movie", "series"]) {
        const original = Object.fromEntries(methods.map(name => [name, proto[name]]));
        const env = process.env.CATALOG_PREFETCH_NEXT_PAGE;
        const id = type === "movie" ? "iptv_vod_2" : "iptv_series_3";
        const old = preview({ id, type, description: undefined, director: ["Director"],
            missingMetadataCheckedAt: Date.now() - 13 * HOUR });
        const complete = { ...old, description: "Complete current description", missingMetadataCheckedAt: Date.now() };
        const extra = { ...complete, id: type === "movie" ? "iptv_vod_4" : "iptv_series_4", name: "Added title" };
        let instance, iface, release, start;
        const started = new Promise(resolve => { start = resolve; });
        const response = new Promise(resolve => { release = resolve; });
        let lookups = 0;
        proto.loadFromCache = async function () {
            instance = this; this.log = quiet; this.lastUpdate = Date.now(); this.epgData = {};
            this.channels = []; this.movies = []; this.series = [];
            this[type === "movie" ? "movies" : "series"] = [{ id, type, name: old.name, tmdbId: "123", series_id: "3" }];
            this.persistentCatalogMetaCache = store([old]);
            this.persistentAddonDataCache = { flush: async () => {} };
            this.persistentSeriesInfoCache = { entries: new Map(), flush: async () => {} };
            this._getCatalogMetaAsync = async () => { lookups++; start(); await response; return complete; };
        };
        proto.updateData = async () => {};
        proto.startConfiguredCatalogPrefetch = () => {};
        proto.startScheduledRefresh = () => {};
        process.env.CATALOG_PREFETCH_NEXT_PAGE = "false";
        try {
            iface = await createAddon({ provider: "direct", includeSeries: true, m3uUrl: "https://example.com/page-refresh-" + type + ".m3u" });
            const pending = iface.get("catalog", type, type === "movie" ? "iptv_movies" : "iptv_series", {});
            await started;
            instance.lastUpdate++;
            const section = type === "movie" ? "movies" : "series";
            instance[section] = [...instance[section].map(item => ({ ...item })),
                { id: extra.id, type, name: extra.name, tmdbId: "123", series_id: "4" }];
            await instance.persistentCatalogMetaCache.set(id, complete);
            await instance.persistentCatalogMetaCache.set(extra.id, extra);
            instance.catalogMetaCache.clear();
            release();
            const result = await pending;
            assert.strictEqual(result.metas.length, 2, "the rebuilt page must use current provider membership");
            assert.ok(result.metas.every(meta => meta.description === complete.description));
            assert.strictEqual(lookups, 1, "current saved metadata must be reused when retrying the page");
        } finally {
            release();
            if (iface) await createAddon.disposeAddonInterface(iface);
            for (const method of methods) proto[method] = original[method];
            if (env === undefined) delete process.env.CATALOG_PREFETCH_NEXT_PAGE; else process.env.CATALOG_PREFETCH_NEXT_PAGE = env;
        }
    }
}

async function testDetailReadsDoNotPostponeMissingSourceRetries() {
    await withClock(async clock => {
        for (const missing of ["imdbRating", "description"]) {
            const saved = preview({ [missing]: undefined, metadataCheckedAt: Date.now() - DAY,
                missingMetadataCheckedAt: Date.now() - 11 * HOUR, omdbCheckedAt: Date.now() - 11 * HOUR });
            const instance = addon("detail-clock-" + missing, saved);
            instance.ensureSeriesInfo = async () => ({ videos: [] });
            const oldClock = saved.missingMetadataCheckedAt;
            let requests = 0;
            await mockMethods(tmdb, { getSeriesMetadata: async () => ({
                name: saved.name, imdbId: saved.imdbId, runtime: saved.runtime,
                description: saved.description, genres: saved.genres, cast: saved.cast
            }) }, async () => mockMethods(omdb, {
                getByImdbId: async () => { requests++; return { imdbId: saved.imdbId, omdbChecked: true, omdbCheckedAt: Date.now() }; },
                shouldRetryLookup: () => false
            }, async () => {
                await instance.buildSeriesMeta(instance.series[0]); await settle(instance);
                assert.strictEqual(requests, 0);
                assert.strictEqual(instance.persistentCatalogMetaCache.entries.get(saved.id).value.missingMetadataCheckedAt, oldClock);
                clock.advance(HOUR + 1);
                assert.strictEqual(createAddon.catalogMetadataNeedsRefresh(
                    instance.persistentCatalogMetaCache.entries.get(saved.id).value), true);
                if (missing === "imdbRating") {
                    await instance.buildSeriesMeta(instance.series[0]); await settle(instance);
                    assert.strictEqual(requests, 1);
                    assert.strictEqual(createAddon.catalogMetadataNeedsRefresh(
                        instance.persistentCatalogMetaCache.entries.get(saved.id).value), false,
                    "an actual OMDb attempt, unlike a page read, should start its retry window");
                }
            }));
        }
    });
}

async function testRuntimeIdentityReconcilesBeforeAveragingAndBacksOffFailure() {
    await withClock(async clock => {
        for (const success of [true, false]) {
            const saved = preview({ _tmdbId: "999", runtime: "22 min", runtimeAverage: {
                version: 1, policyVersion: 1, runtime: "22 min", source: "tmdb-episodes",
                checkedAt: Date.now() - 15 * DAY, attemptedAt: Date.now() - 15 * DAY,
                tmdbId: "999", complete: true, episodeCount: 2, totalMinutes: 44, seasons: []
            } });
            const instance = addon("runtime-id-" + success, saved);
            let calls = 0;
            await mockMethods(tmdb, {
                getSeriesCatalogMetadata: async (id, options) => {
                    calls++; assert.strictEqual(id, "123"); assert.strictEqual(options.refresh, true);
                    return success ? preview({ name: "Correct identity", runtime: "60 min" }) : null;
                },
                getSeriesRuntimeMetadata: async () => { throw new Error("Do not average before reconciling the title's identity"); }
            }, async () => mockMethods(omdb, {
                getByImdbId: async () => ({ imdbId: saved.imdbId, imdbRating: "8.0", runtime: "60 min", omdbChecked: true }),
                shouldRetryLookup: () => false
            }, async () => {
                const first = await instance.ensureSeriesRuntimeAverage(instance.series[0], saved);
                await instance.ensureSeriesRuntimeAverage(instance.series[0], first);
                assert.strictEqual(calls, 1);
                assert.strictEqual(first.runtime, success ? "60 min" : "22 min");
                if (success) {
                    assert.strictEqual(first._tmdbId, "123"); assert.strictEqual(first.name, "Correct identity");
                } else {
                    assert.strictEqual(first.runtimeAverage.attemptedAt, Date.now());
                    clock.advance(12 * HOUR + 1);
                    await instance.ensureSeriesRuntimeAverage(instance.series[0], first);
                    assert.strictEqual(calls, 2);
                }
            }));
        }
    });
}

async function testScanMarkersRespectOrdinaryExpiryAcrossRestartAndMemory() {
    await withClock(async clock => {
        for (const restart of [false, true]) {
            const saved = preview({ metadataCheckedAt: Date.now() - 14 * DAY + 30 * 60000 });
            const instance = addon("expiry-" + restart, saved);
            const key = "__catalog_prefetch_status__:series";
            const fingerprint = crypto.createHash("sha256").update(saved.id).digest("hex");
            await instance.persistentCatalogMetaCache.set(key, {
                catalogueFingerprint: fingerprint, completedAt: Date.now() - HOUR, version: 4
            });
            let calls = 0;
            instance._getCatalogMetaAsync = async () => { calls++; return { ...saved, description: "Updated source description" }; };
            if (!restart) {
                instance.startContinuousCatalogPrefetch("series", 50, 1);
                await instance.catalogPrefetchJobs.get("series");
                await new Promise(resolve => setImmediate(resolve));
                assert.strictEqual(calls, 0);
                assert.strictEqual(instance.catalogPrefetchNextCheckAt.get("series"), saved.metadataCheckedAt + 14 * DAY);
            }
            clock.advance(31 * 60000);
            instance.startContinuousCatalogPrefetch("series", 50, 1);
            await instance.catalogPrefetchJobs.get("series");
            assert.strictEqual(calls, 1, "a recent scan marker must not hide due full metadata work");
            assert.strictEqual(instance.persistentCatalogMetaCache.entries.get(saved.id).value.description, "Updated source description");
        }
    });
}

async function testUnchangedScansDoNotRewritePersistentPreviews() {
    const values = [1, 2, 3].map(id => preview({ id: "iptv_series_" + id }));
    const instance = addon("unchanged-writes");
    instance.series = values.map(value => ({ id: value.id, type: value.type, name: value.name, tmdbId: "123" }));
    const cache = new PersistentCatalogMetaCache("write-dedup", { directory: "" });
    cache.enabled = true; cache.init = async () => {}; cache.scheduleWrite = () => {}; cache.flush = async () => {};
    const changedKeys = [];
    cache.journal = { mark: key => changedKeys.push(key) };
    for (const value of values) {
        cache.entries.set(value.id, { value: structuredClone(value), savedAt: Date.now() - HOUR });
        instance.catalogMetaCache.set(value.id, value);
    }
    instance.persistentCatalogMetaCache = cache;
    instance._getCatalogMetaAsync = async () => { throw new Error("Fresh source metadata should be reused"); };
    instance.startContinuousCatalogPrefetch("series", 50, 1);
    await instance.catalogPrefetchJobs.get("series"); await settle(instance);
    assert.deepStrictEqual(changedKeys, ["__catalog_prefetch_status__:series"]);
    const oldSavedAt = cache.entries.get(values[0].id).savedAt;
    await cache.set(values[0].id, structuredClone(values[0]));
    assert.strictEqual(cache.entries.get(values[0].id).savedAt, oldSavedAt);
    await cache.set(values[0].id, { ...values[0], description: "Changed description" });
    assert.deepStrictEqual(changedKeys.slice(1), [values[0].id], "real changes must still be journaled");
}

async function testFailedGuideRetriesIndependentlyWithoutCatalogueDownload() {
    await withClock(async clock => {
        for (const name of ["direct", "xtream"]) {
            const instance = addon("guide-retry-" + name, preview(), name);
            instance.config.enableEpg = true;
            instance.epgData = { "channel.one": [{ title: "Saved programme" }] };
            instance.lastEpgUpdate = Date.now() - 13 * HOUR;
            const oldGuide = instance.epgData;
            let catalogues = 0, guides = 0;
            const provider = require("../src/js/providers/" + name + "Provider");
            await mockMethods(provider, {
                fetchData: async (target, options) => {
                    catalogues++; assert.strictEqual(options.skipEpg, false);
                    fill(target, instance, { epgData: {}, epgRefreshFailed: true });
                },
                fetchEpg: async target => { guides++; target.epgData = { "channel.one": [{ title: "Recovered programme" }] }; }
            }, async () => {
                await instance.updateData();
                const generation = instance.lastUpdate, channels = instance.channels;
                assert.strictEqual(instance.epgData, oldGuide);
                clock.advance(30 * 60000);
                await instance.updateData();
                assert.strictEqual(guides, 0);
                clock.advance(30 * 60000 + 1);
                await Promise.all([instance.updateData(), instance.updateData()]);
                assert.strictEqual(catalogues, 1);
                assert.strictEqual(guides, 1);
                assert.strictEqual(instance.lastUpdate, generation);
                assert.strictEqual(instance.channels, channels);
                assert.strictEqual(instance.lastEpgUpdate, Date.now());
                assert.strictEqual(instance.epgData["channel.one"][0].title, "Recovered programme");
                assert.strictEqual(instance.snapshots.at(-1).lastEpgUpdate, Date.now());
            });
        }
    });
}

async function testGuidePublishFailureRestoresGuideAndRetryClock() {
    await withClock(async () => {
        const instance = addon("guide-publish-failure");
        instance.config.enableEpg = true;
        instance.lastUpdate = Date.now();
        instance.lastEpgUpdate = Date.now() - 13 * HOUR;
        const oldSuccess = instance.lastEpgUpdate;
        const oldGuide = instance.epgData = { "channel.one": [{ title: "Saved programme" }] };
        instance.buildGenresInManifest = () => { throw new Error("Manifest unavailable"); };
        const provider = require("../src/js/providers/directProvider");
        await mockMethods(provider, { fetchEpg: async target => {
            target.epgData = { "channel.one": [{ title: "New programme" }] };
        } }, async () => {
            await instance.updateData();
            assert.strictEqual(instance.epgData, oldGuide);
            assert.strictEqual(instance.lastEpgUpdate, oldSuccess);
            assert.strictEqual(instance.epgRefreshAttemptedAt, Date.now());
            assert.strictEqual(instance.isEpgRefreshDue(), false);
            assert.strictEqual(instance.snapshots.at(-1).lastEpgUpdate, oldSuccess);
        });
    });
}

async function testFirstPartialGuideRemainsAvailableWhileRetryIsDeferred() {
    await withClock(async clock => {
        const instance = addon("guide-initial-partial");
        instance.config.enableEpg = true;
        instance.lastUpdate = Date.now();
        instance.lastEpgUpdate = 0;
        instance.epgData = {};
        const provider = require("../src/js/providers/directProvider");
        let requests = 0;
        await mockMethods(provider, { fetchEpg: async target => {
            requests++;
            target.epgRefreshFailed = true;
            target.epgData = { "channel.one": [{ title: "Available partial guide" }] };
        } }, async () => {
            await instance.updateData();
            assert.strictEqual(instance.epgData["channel.one"][0].title, "Available partial guide");
            assert.strictEqual(instance.lastEpgUpdate, 0, "a partial guide must not postpone retry for 12 hours");
            assert.strictEqual(instance.snapshots.at(-1).lastEpgUpdate, 0);
            await instance.updateData();
            assert.strictEqual(requests, 1);
            clock.advance(HOUR);
            assert.strictEqual(instance.isEpgRefreshDue(), true);
        });
    });
}

async function testProviderRetriesAndDropConfirmationsRequireTimeSeparation() {
    await withClock(async clock => {
        const provider = require("../src/js/providers/directProvider");
        const failed = addon("provider-retry");
        const originalUpdate = failed.lastUpdate;
        let calls = 0;
        await mockMethods(provider, { fetchData: async () => { calls++; throw new Error("Provider failure"); } }, async () => {
            await failed.updateData();
            await failed.updateData(true);
            assert.strictEqual(calls, 1);
            assert.strictEqual(failed.lastUpdate, originalUpdate);
            assert.strictEqual(failed.snapshots[0].lastUpdate, originalUpdate);
            clock.set(failed.providerRefreshRetryAfter);
            await failed.updateData();
            assert.strictEqual(calls, 2);
        });
        const guarded = addon("guard-spacing");
        guarded.movies = Array.from({ length: 100 }, (_, index) => ({ id: "iptv_vod_" + index, name: "Movie", type: "movie" }));
        const reduced = guarded.movies.slice(0, 20);
        let observations = 0;
        await mockMethods(provider, { fetchData: async target => { observations++; fill(target, guarded, { movies: reduced }); } }, async () => {
            await guarded.updateData();
            assert.strictEqual(guarded.movies.length, 100);
            const firstObservation = guarded.pendingRemovalCandidates.movies.observedAt;
            clock.advance(1000);
            await guarded.updateData(true);
            assert.strictEqual(observations, 1);
            assert.strictEqual(guarded.movies.length, 100);
            clock.set(guarded.providerRefreshRetryAfter);
            await guarded.updateData(true);
            assert.strictEqual(observations, 2);
            assert.strictEqual(guarded.movies.length, 20);
            assert.ok(Date.now() - firstObservation >= HOUR);
        });
    });
}

async function testGuideOnlyProviderFetchersAvoidCatalogueEndpoints() {
    const xml = '<tv><programme channel="channel.one" start="20261030000000 +0000" stop="20261030235900 +0000"><title>Guide</title></programme></tv>';
    for (const name of ["direct", "xtream"]) {
        const urls = [];
        const fetch = async url => {
            urls.push(String(url));
            if (String(url).endsWith(".xml")) return { ok: true, body: Readable.from([xml]) };
            if (String(url).endsWith(".m3u")) return { ok: true, text: async () =>
                '#EXTM3U\n#EXTINF:-1 tvg-id="channel.one",Channel\nhttps://example.com/live.m3u8\n' };
            const action = new URL(url).searchParams.get("action");
            return { ok: true, json: async () => action === "get_live_streams"
                ? [{ stream_id: 1, name: "Channel", epg_channel_id: "channel.one" }] : [] };
        };
        await withProviderFetch(name, fetch, async provider => {
            const target = { config: { provider: name, enableEpg: true, includeSeries: false,
                m3uUrl: "https://example.com/playlist.m3u", epgUrl: "https://example.com/guide.xml",
                xtreamUrl: "https://example.com", xtreamUsername: "test", xtreamPassword: "test" },
                channels: [{ attributes: { "tvg-id": "channel.one" } }], log: quiet,
                parseM3U: M3UEPGAddon.prototype.parseM3U, parseAttributes: M3UEPGAddon.prototype.parseAttributes,
                isMovieFormat: () => false, isTVFormat: () => true };
            await provider.fetchEpg(target);
            assert.deepStrictEqual(urls, ["https://example.com/guide.xml"]);
            assert.strictEqual(target.epgData["channel.one"][0].title, "Guide");
            const guide = target.epgData; urls.length = 0;
            await provider.fetchData(target, { skipEpg: true });
            assert.strictEqual(target.epgData, guide);
            assert.ok(urls.every(url => !url.endsWith(".xml")));
        });
    }
}

async function withTemporaryDirectory(run) {
    const base = path.resolve(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(base, "iptv-refresh-fixes-"));
    try { return await run(directory); }
    finally {
        if (!path.resolve(directory).startsWith(base + path.sep)) throw new Error("Unsafe test cleanup path");
        await fs.rm(directory, { recursive: true, force: true });
    }
}

async function testRefreshClocksPersistAndLegacySnapshotsStillLoad() {
    await withTemporaryDirectory(async directory => {
        const original = addon("clock-volume", preview(), "xtream");
        original.lastUpdate = Date.now();
        original.lastEpgUpdate = Date.now() - 12 * HOUR;
        original.epgRefreshAttemptedAt = Date.now();
        original.providerRefreshRetryAfter = Date.now() + HOUR;
        original.epgData = { "channel.one": [{ title: "Saved guide" }] };
        const cache = new PersistentAddonDataCache("refresh-clock-volume", { directory });
        await cache.save(original.providerSnapshot());
        const restored = addon("clock-volume", preview(), "xtream");
        restored.persistentAddonDataCache = cache;
        await restored.loadFromCache();
        for (const field of ["lastUpdate", "lastEpgUpdate", "epgRefreshAttemptedAt", "providerRefreshRetryAfter"])
            assert.strictEqual(restored[field], original[field]);
        assert.strictEqual(restored.isEpgRefreshDue(), false);
        const legacy = original.providerSnapshot();
        delete legacy.lastEpgUpdate; delete legacy.epgRefreshAttemptedAt; delete legacy.providerRefreshRetryAfter;
        await cache.save(legacy);
        const old = addon("clock-volume-legacy", preview(), "xtream"); old.persistentAddonDataCache = cache;
        await old.loadFromCache();
        assert.strictEqual(old.lastEpgUpdate, legacy.lastUpdate);
        assert.strictEqual(old.epgRefreshAttemptedAt, 0);
        assert.strictEqual(old.providerRefreshRetryAfter, 0);
    });
}

async function testDisposalReportsFlushFailuresAfterTryingEveryStore() {
    const instance = addon("flush-failures");
    const attempted = [];
    instance.persistentAddonDataCache.flush = async () => { attempted.push("provider"); throw new Error("Disk full"); };
    instance.persistentCatalogMetaCache.flush = async () => { attempted.push("metadata"); throw new Error("Permission failure"); };
    instance.persistentSeriesInfoCache.flush = async () => { attempted.push("series"); };
    let released = 0;
    instance.releasePersistentCacheRegistration = () => { released++; };
    await assert.rejects(() => instance.dispose(), error => {
        assert.strictEqual(error.name, "AggregateError");
        assert.deepStrictEqual(error.failedCaches, ["provider snapshot", "catalogue metadata"]);
        return true;
    });
    assert.deepStrictEqual(attempted.sort(), ["metadata", "metadata", "provider", "provider", "series", "series"]);
    assert.strictEqual(released, 1);
    await assert.rejects(() => instance.dispose());
    assert.strictEqual(attempted.length, 6, "repeat disposal joins the original early/final flush operation");
}

async function runApiProbe(mode) {
    await withTemporaryDirectory(async directory => {
        const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/refreshApiProbe.js"), mode], {
            cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 20000,
            env: { ...process.env, PERSISTENT_DATA_DIR: directory, TMDB_API_KEY: "test-key", OMDB_API_KEY: "test-key" }
        });
        assert.strictEqual(result.status, 0, result.stderr + "\n" + result.stdout);
    });
}
async function testFullMetadataRefreshBypassesFreshRawApiCaches() { await runApiProbe("full-metadata"); }
async function testFailedOmdbFullRefreshRetriesRetainedCompleteValues() { await runApiProbe("omdb-retry"); }
async function testFullRuntimeRefreshRechecksFreshSeasonTotalsAtConfiguredInterval() { await runApiProbe("runtime"); }

module.exports = [
    testOpenXtreamSeriesRemainsPlayableAfterProviderRefresh,
    testRemovedAndReplacedSeriesLoseOldStreamMappings,
    testEpisodeStreamsRecoverFromVolumeWithoutProviderRequests,
    testPersistentEpisodeIndexTracksChangesAndRetention,
    testMalformedSuccessfulSeriesResponsesPreserveSavedEpisodes,
    testCataloguePagesRebuildAcrossRefreshIncludingNewItems,
    testDetailReadsDoNotPostponeMissingSourceRetries,
    testRuntimeIdentityReconcilesBeforeAveragingAndBacksOffFailure,
    testScanMarkersRespectOrdinaryExpiryAcrossRestartAndMemory,
    testUnchangedScansDoNotRewritePersistentPreviews,
    testFailedGuideRetriesIndependentlyWithoutCatalogueDownload,
    testGuidePublishFailureRestoresGuideAndRetryClock,
    testFirstPartialGuideRemainsAvailableWhileRetryIsDeferred,
    testProviderRetriesAndDropConfirmationsRequireTimeSeparation,
    testGuideOnlyProviderFetchersAvoidCatalogueEndpoints,
    testRefreshClocksPersistAndLegacySnapshotsStillLoad,
    testDisposalReportsFlushFailuresAfterTryingEveryStore,
    testFullMetadataRefreshBypassesFreshRawApiCaches,
    testFailedOmdbFullRefreshRetriesRetainedCompleteValues,
    testFullRuntimeRefreshRechecksFreshSeasonTotalsAtConfiguredInterval
];
