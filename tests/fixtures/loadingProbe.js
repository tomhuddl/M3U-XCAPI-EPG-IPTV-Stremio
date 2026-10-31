"use strict";
const fs = require("fs"), path = require("path"), Module = require("module"), http = require("http"), zlib = require("zlib"), assert = require("assert");
const root = path.resolve(__dirname, "../..");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function httpProbe() {
    process.env.CONFIG_SECRET = "loading-test-secret-not-a-real-deployment-secret";
    process.env.LOG_LEVEL = "error";
    const sdk = require("stremio-addon-sdk"), originalRouter = sdk.getRouter;
    let routerBuilds = 0, builds = 0, released = 0, heldResponse;
    const resourceGate = deferred(), resourceStarted = deferred();
    sdk.getRouter = (...args) => { routerBuilds++; return originalRouter(...args); };
    const addonPath = require.resolve(path.join(root, "addon")), actual = require(addonPath);
    const gate = deferred();
    const iface = { manifest: { id: "audit", version: "1.0.0", name: "Audit", catalogs: [],
        types: ["tv", "movie", "series"], resources: ["meta", "catalog", "stream"] },
        get: async (resource, type, id) => {
            if (id === "iptv_vod_3") { resourceStarted.resolve(); await resourceGate.promise; }
            if (resource === "stream") return { streams: [{ url: "https://example.com/stream.mp4" }] };
            const meta = { id, type, name: "Title", description: "Available description ".repeat(300), metadataVersion: 3,
                omdbCheckedAt: 123, links: [{ name: "Writer", category: "Writers", url: "https://example.com/writer" },
                    { name: "Actor", category: "Cast", url: "https://example.com/actor" }] };
            return resource === "meta" ? { meta } : { metas: [meta] };
        } };
    const fake = async () => { builds++; await gate.promise; return iface; };
    Object.assign(fake, { createInterfaceKey: actual.createInterfaceKey, acquireAddonInterface: () => true,
        releaseAddonInterface() { released++; }, disposeAddonInterface: async () => {}, flushAddonDisposals: async () => {}, closeRedisClient: async () => {} });
    require.cache[addonPath].exports = fake;
    const serverPath = path.join(root, "server.js"), mod = new Module(serverPath, module);
    mod.filename = serverPath; mod.paths = Module._nodeModulePaths(root);
    const source = fs.readFileSync(serverPath, "utf8").replace(/const server = app\.listen\(port, \(\) => \{[\s\S]*?\n\}\);/,
        "const server = { close(resolve) { resolve(); } };");
    mod._compile(source + "\nmodule.exports = { app };", serverPath);
    const { app } = mod.exports;
    const { encryptConfig } = require(path.join(root, "cryptoConfig"));
    const token = encryptConfig(JSON.stringify({ provider: "direct", m3uUrl: "https://example.com/list.m3u" }));
    const request = (suffix, agent = "Stremio Windows", accept = "gzip") => new Promise((resolve, reject) => {
        const req = new http.IncomingMessage({ remoteAddress: "127.0.0.1" });
        req.method = "GET"; req.url = "/" + token + suffix;
        req.headers = { host: "addon.example", "user-agent": agent, "accept-encoding": accept };
        const res = new http.ServerResponse(req);
        if (suffix.includes("iptv_vod_3")) heldResponse = res;
        res.end = function (chunk) {
            try {
                const encoding = this.getHeader("Content-Encoding");
                const text = encoding === "gzip" ? zlib.gunzipSync(chunk).toString() : encoding === "br"
                    ? zlib.brotliDecompressSync(chunk).toString() : String(chunk);
                this.finished = true; this.emit("finish");
                resolve({ status: this.statusCode, headers: this.getHeaders(), body: JSON.parse(text) });
            } catch (error) { reject(error); }
            return this;
        };
        app.handle(req, res, reject);
    });
    const pending = [request("/meta/movie/iptv_vod_2.json"), request("/stream/movie/iptv_vod_2.json"), request("/catalog/movie/iptv_movies.json")];
    await tick(); assert.strictEqual(builds, 1); gate.resolve();
    const responses = await Promise.all(pending); assert.deepStrictEqual(responses.map(r => r.status), [200, 200, 200]);
    assert.strictEqual(responses[0].body.meta.metadataVersion, undefined);
    assert.strictEqual(responses[0].headers["content-encoding"], "gzip");
    assert.strictEqual(responses[1].headers["content-encoding"], undefined);
    assert.match(responses[0].headers.vary, /Accept-Encoding/i);
    const ios = await request("/meta/movie/iptv_vod_2.json", "Stremio iOS iPhone", "br");
    const win = await request("/meta/movie/iptv_vod_2.json", "Stremio Windows", "gzip;q=0, br;q=0");
    assert.strictEqual(ios.headers["content-encoding"], "br"); assert.strictEqual(win.headers["content-encoding"], undefined);
    assert.strictEqual(win.body.meta.links.filter(l => l.category === "Writers").length, 0);
    assert.strictEqual(ios.body.meta.links.filter(l => l.category === "Writers").length, 1);
    assert.strictEqual(routerBuilds, 1);
    assert.match(win.headers["cache-control"], /no-store/);
    const beforeClose = released, closedRequest = request("/meta/movie/iptv_vod_3.json");
    await resourceStarted.promise; heldResponse.emit("close"); await tick();
    assert.strictEqual(released, beforeClose, "an abandoned request must retain its interface lease until shared work ends");
    resourceGate.resolve(); await closedRequest; await tick();
    assert.strictEqual(released, beforeClose + 1);
}

async function apiProbe() {
    process.env.TMDB_API_KEY = "loading-test-key"; delete process.env.OMDB_API_KEY;
    const safety = require(path.join(root, "urlSafety")), trailerGate = deferred(), calls = [];
    safety.safeFetch = async url => {
        const parsed = new URL(url);
        if (parsed.hostname === "example.com") return { ok: true, json: async () => {
            const action = parsed.searchParams.get("action");
            return action === "get_live_streams" ? [{ stream_id: 1, name: "Live" }]
                : action === "get_vod_streams" ? [{ stream_id: 2, name: "Movie", container_extension: "mp4" }] : [];
        } };
        assert.strictEqual(parsed.hostname, "api.themoviedb.org", "no real upstream requests allowed");
        calls.push(parsed.pathname); let value;
        if (parsed.pathname.endsWith("/videos")) { await trailerGate.promise; value = { results: [] }; }
        else if (parsed.pathname.includes("/season/")) value = { episodes: [
            { id: 1, season_number: 1, episode_number: 1, name: "Episode", runtime: 50, air_date: "2020-01-01" }] };
        else value = { id: 123, name: "Example", overview: "Description", poster_path: "/p.jpg", backdrop_path: "/b.jpg",
            first_air_date: "2020-01-01", episode_run_time: parsed.pathname.includes("124") ? [60] : [],
            external_ids: { imdb_id: "tt1234567" }, seasons: [{ season_number: 1, episode_count: 1 }], number_of_episodes: 1,
            genres: [{ id: 18, name: "Drama" }], aggregate_credits: { cast: [{ id: 1, name: "Actor" }] } };
        return { ok: true, status: 200, text: async () => JSON.stringify(value) };
    };
    const { M3UEPGAddon } = require(path.join(root, "addon")), tmdb = require(path.join(root, "src/js/tmdbMetadata"));
    const setup = tmdbId => {
        const addon = new M3UEPGAddon({ provider: "direct", enableEpg: false }); addon.log = quiet; addon.lastUpdate = Date.now();
        const item = { id: "iptv_series_3", series_id: "3", type: "series", name: "Example", tmdbId }; addon.series = [item];
        const value = { ...item, _tmdbId: tmdbId, poster: "https://example.com/p.jpg", background: "https://example.com/b.jpg",
            description: "Description", genres: ["Drama"], year: 2020, cast: ["Actor"], imdbId: "tt1234567", imdbRating: "8.0",
            metadataVersion: 3, imdbIdChecked: true, metadataCheckedAt: Date.now() - 15 * 86400000,
            missingMetadataCheckedAt: Date.now() - 15 * 86400000, runtime: "49 min",
            runtimeAverage: { version: 1, policyVersion: 1, runtime: "49 min", source: "tmdb-episodes", complete: true,
                tmdbId, checkedAt: Date.now() - 15 * 86400000, attemptedAt: Date.now() - 15 * 86400000, seasons: [] } };
        const entries = new Map([[item.id, { value, savedAt: Date.now() }]]);
        addon.persistentCatalogMetaCache = { get: async id => entries.get(id), set: async (id, v) => entries.set(id, { value: v, savedAt: Date.now() }) };
        addon.ensureSeriesInfo = async () => ({ videos: [{ id: "ep", season: 1, episode: 1 }] });
        addon.getDetailOmdbMetadata = async () => null; return { addon, item };
    };
    const average = setup("123"); await average.addon.enrichCatalogMetaItems([average.item], 1);
    assert.strictEqual(calls.filter(p => p === "/3/tv/123").length, 1);
    const detail = setup("124"), pending = detail.addon.buildSeriesMeta(detail.item);
    await tick(); await tick();
    assert.ok(calls.some(p => p === "/3/tv/124/season/1"), "season work must not wait for trailers");
    trailerGate.resolve(); await pending;
    const before = calls.length;
    await tmdb.getSeriesMetadata("124", { cachedMetadata: { name: "Saved" }, detailExtras: {
        tmdbId: "124", checkedAt: Date.now(), failed: false, trailer: null } });
    assert.strictEqual(calls.length, before, "fresh saved preview and checked trailers must avoid a raw API request");
    const provider = require(path.join(root, "src/js/providers/xtreamProvider"));
    const target = { config: { xtreamUrl: "https://example.com", xtreamUsername: "test/user", xtreamPassword: "fake?#pass",
        includeSeries: false, enableEpg: false }, log: quiet };
    await provider.fetchData(target);
    for (const item of [...target.channels, ...target.movies]) {
        const url = new URL(item.url); assert.strictEqual(url.search, ""); assert.strictEqual(url.hash, "");
        assert.ok(url.pathname.includes("test%2Fuser/fake%3F%23pass"));
    }
}

async function startupProbe() {
    const createAddon = require(path.join(root, "addon")), proto = createAddon.M3UEPGAddon.prototype;
    const gate = deferred(); let live, metadataLoaded = false;
    proto.loadFromCache = async function () {
        live = this; this.log = quiet; this.lastUpdate = Date.now() - 13 * 3600000;
        this.channels = [{ id: "iptv_live_1", type: "tv", name: "Saved channel", url: "https://example.com/live.ts" }];
        this.persistentCatalogMetaCache = { entries: new Map(), init: async () => { metadataLoaded = true; }, flush: async () => {} };
    };
    proto.updateData = async () => gate.promise;
    proto.startConfiguredCatalogPrefetch = proto.startScheduledRefresh = () => {};
    const iface = await createAddon({ provider: "direct", m3uUrl: "https://example.com/startup-probe.m3u", enableEpg: false });
    assert.strictEqual(metadataLoaded, true);
    const stream = await iface.get("stream", "tv", "iptv_live_1"); assert.strictEqual(stream.streams.length, 1);
    live.getDetailedMetaAsync = async () => { throw new Error("Simulated failure"); };
    await assert.rejects(() => iface.get("meta", "movie", "iptv_vod_2"), /Metadata temporarily unavailable/);
    gate.resolve(); await tick(); await createAddon.disposeAddonInterface(iface);
    proto.loadFromCache = async function () {
        this.log = quiet; this.lastUpdate = 0;
        this.persistentCatalogMetaCache = { entries: new Map(), init: async () => {}, flush: async () => {} };
    };
    proto.updateData = async () => {};
    await assert.rejects(() => createAddon({ provider: "direct", m3uUrl: "https://example.com/unavailable.m3u" }),
        /Provider catalogue temporarily unavailable/);
}
const modes = { http: httpProbe, api: apiProbe, startup: startupProbe };
Promise.resolve().then(() => modes[process.argv[2]]()).then(() => console.log("PASS " + process.argv[2]))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
