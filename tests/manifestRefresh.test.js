const assert = require("assert");
const { addonBuilder } = require("stremio-addon-sdk");
const createAddon = require("../addon");
const { M3UEPGAddon, disposeAddonInterface } = createAddon;

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

function catalogStore(values) {
    const entries = new Map(values.map(value => [value.id, { value: structuredClone(value), savedAt: Date.now() }]));
    return {
        entries,
        init: async () => {},
        get: async key => entries.get(String(key)) || null,
        set: async (key, value) => entries.set(String(key), { value: structuredClone(value), savedAt: Date.now() }),
        delete: async key => entries.delete(String(key)),
        retainCatalogItems: async ids => {
            for (const id of entries.keys()) if (!ids.has(id) && !id.startsWith("__")) entries.delete(id);
        },
        flush: async () => {}
    };
}

async function testProviderRefreshAfterSdkBuildUpdatesLiveManifestAndSnapshot() {
    const proto = M3UEPGAddon.prototype;
    for (const providerName of ["direct", "xtream"]) {
        const provider = require("../src/js/providers/" + providerName + "Provider");
        const original = {
            loadFromCache: proto.loadFromCache,
            startConfiguredCatalogPrefetch: proto.startConfiguredCatalogPrefetch,
            startScheduledRefresh: proto.startScheduledRefresh,
            fetchData: provider.fetchData
        };
        const savedPreviews = [
            { id: "iptv_vod_2", type: "movie", name: "Movie", description: "Saved movie description", year: 2026 },
            { id: "iptv_series_3", type: "series", name: "Series", description: "Saved series description", year: 2026,
                runtime: "49 min", runtimeAverage: { version: 1, runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441 } }
        ];
        const snapshots = [];
        const logs = [];
        let instance;
        let iface;
        let fetches = 0;
        let fail = false;
        let clearGenres = false;
        proto.loadFromCache = async function () {
            instance = this;
            this.log = Object.fromEntries(["debug", "info", "warn", "error"].map(level =>
                [level, (message, details) => logs.push({ level, message, details })]));
            this.channels = [{ id: "iptv_live_1", type: "tv", name: "Live", category: "Old live", attributes: { "tvg-id": "channel.one" } }];
            this.movies = [{ id: "iptv_vod_2", type: "movie", name: "Movie", category: "Old movies" }];
            this.series = [{ id: "iptv_series_3", type: "series", series_id: "3", name: "Series" }];
            this.epgData = {};
            this.lastUpdate = Date.now();
            this.persistentCatalogMetaCache = catalogStore(savedPreviews);
            this.persistentSeriesInfoCache = {
                entries: new Map(), maxEntries: 1,
                retainSeries: async () => {}, flush: async () => {}
            };
            this.persistentAddonDataCache = {
                save: async entry => { snapshots.push(structuredClone(entry)); return true; },
                flush: async () => {}
            };
        };
        proto.startConfiguredCatalogPrefetch = () => {};
        proto.startScheduledRefresh = () => {};
        provider.fetchData = async refreshed => {
            fetches++;
            if (fail) throw new Error("Simulated provider failure");
            refreshed.channels = [
                { id: "iptv_live_1", type: "tv", name: "Live", category: "Refreshed live", attributes: { "tvg-id": "channel.one" } },
                { id: "iptv_live_4", type: "tv", name: "Added channel", category: "New category" }
            ];
            refreshed.movies = [{ id: "iptv_vod_2", type: "movie", name: "Movie", category: clearGenres ? undefined : "Refreshed movies" }];
            refreshed.series = [{ id: "iptv_series_3", type: "series", series_id: "3", name: "Series", category: clearGenres ? undefined : "Refreshed series" }];
            refreshed.epgData = { "channel.one": [{ title: "Refreshed guide " + fetches, start: "20261028120000 +0000", stop: "20261028130000 +0000" }] };
        };
        try {
            const unique = providerName + "-sdk-refresh-" + Date.now();
            const config = { provider: providerName, includeSeries: true, enableEpg: true,
                m3uUrl: "https://example.com/" + unique + ".m3u",
                xtreamUrl: "https://example.com/" + unique, xtreamUsername: "test-user", xtreamPassword: "test-password" };
            iface = await createAddon(config);
            assert.strictEqual(fetches, 0, "saved startup data should be used before testing a later refresh");
            assert.strictEqual(Object.isFrozen(instance.manifestRef), true, "the actual SDK must have frozen the top-level manifest");
            assert.strictEqual(Object.isFrozen(iface.manifest), true);
            const hints = iface.manifest.behaviorHints;
            const genres = id => iface.manifest.catalogs.find(catalog => catalog.id === id);
            const options = id => genres(id).extra.find(extra => extra.name === "genre").options;
            assert.strictEqual(hints.epgProvider, false);
            assert.deepStrictEqual(genres("iptv_series").genres, []);
            instance.lastUpdate = Date.now() - instance.updateInterval - 1000;
            const overdue = instance.lastUpdate;

            await instance.updateData(true);
            assert.deepStrictEqual(logs.filter(log => log.level === "error"), [],
                providerName + " refresh must succeed after SDK initialization");
            assert.ok(instance.lastUpdate > overdue, "a successful refresh must advance its timestamp");
            assert.strictEqual(snapshots.length, 1, "the validated provider snapshot must be saved");
            assert.strictEqual(snapshots[0].lastUpdate, instance.lastUpdate);
            assert.strictEqual(snapshots[0].channels.length, 2);
            assert.strictEqual(snapshots[0].epgData["channel.one"][0].title, "Refreshed guide 1");
            assert.strictEqual(iface.manifest.behaviorHints, hints, "the SDK and app must retain the same hints object");
            assert.strictEqual(hints.epgProvider, true);
            assert.strictEqual(hints.configurable, true);
            assert.strictEqual(hints.configurationRequired, false);
            assert.deepStrictEqual(options("iptv_channels"), ["All Channels", "Refreshed live", "New category"]);
            assert.deepStrictEqual(options("iptv_movies"), ["Refreshed movies"]);
            assert.deepStrictEqual(genres("iptv_series").genres, ["Refreshed series"]);
            assert.deepStrictEqual(options("iptv_series"), ["Refreshed series"], "an initially empty genre list must update after refresh");
            for (const preview of savedPreviews) {
                assert.deepStrictEqual(instance.persistentCatalogMetaCache.entries.get(preview.id).value, preview,
                    "unchanged titles must retain their saved metadata and runtime aggregates");
            }

            const previous = { channels: instance.channels, movies: instance.movies, series: instance.series,
                epgData: instance.epgData, lastUpdate: instance.lastUpdate, manifest: JSON.stringify(iface.manifest) };
            fail = true;
            await instance.updateData(true);
            for (const key of ["channels", "movies", "series", "epgData", "lastUpdate"]) assert.strictEqual(instance[key], previous[key]);
            assert.strictEqual(JSON.stringify(iface.manifest), previous.manifest);
            assert.strictEqual(snapshots.length, 1, "a failed request must not replace the saved snapshot");
            assert.strictEqual(logs.filter(log => log.level === "error").length, 1);

            fail = false;
            clearGenres = true;
            await instance.updateData(true);
            assert.ok(instance.lastUpdate > previous.lastUpdate, "a later successful refresh must recover normally");
            assert.strictEqual(snapshots.length, 2);
            assert.deepStrictEqual(options("iptv_movies"), [], "removed genre options must not remain in the live manifest");
            assert.deepStrictEqual(options("iptv_series"), []);
            assert.strictEqual(logs.filter(log => log.message === "Provider data refresh complete").length, 2);
            assert.strictEqual(logs.filter(log => log.level === "error").length, 1);
        } finally {
            if (iface) await disposeAddonInterface(iface);
            proto.loadFromCache = original.loadFromCache;
            proto.startConfiguredCatalogPrefetch = original.startConfiguredCatalogPrefetch;
            proto.startScheduledRefresh = original.startScheduledRefresh;
            provider.fetchData = original.fetchData;
        }
    }
}

function testSdkFrozenManifestEpgHintUpdatesPreserveOtherHints() {
    const manifest = {
        id: "org.example.manifest-refresh", version: "1.0.0", name: "Manifest refresh test",
        resources: ["catalog"], types: ["tv"],
        catalogs: [{ id: "iptv_channels", type: "tv", name: "Channels", extra: [{ name: "genre" }], genres: [] }],
        behaviorHints: { configurable: true, configurationRequired: false, epgProvider: false }
    };
    const instance = new M3UEPGAddon({ provider: "direct" }, manifest);
    instance.log = quietLog;
    const builder = new addonBuilder(manifest);
    builder.defineCatalogHandler(async () => ({ metas: [] }));
    const iface = builder.getInterface();
    const hints = iface.manifest.behaviorHints;
    for (const available of [true, false, true]) {
        instance.epgData = available ? { channel: [{ title: "A programme" }] } : {};
        assert.doesNotThrow(() => instance.buildGenresInManifest());
        assert.strictEqual(hints.epgProvider, available);
        assert.strictEqual(iface.manifest.behaviorHints, hints);
        assert.strictEqual(hints.configurable, true);
        assert.strictEqual(hints.configurationRequired, false);
    }
}

module.exports = [
    testProviderRefreshAfterSdkBuildUpdatesLiveManifestAndSnapshot,
    testSdkFrozenManifestEpgHintUpdatesPreserveOtherHints
];
