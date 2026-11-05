"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert"), { Readable } = require("stream");
const mode = process.argv[2];
const directory = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "provider-probe-"));
process.env.PERSISTENT_DATA_DIR = directory;
process.env.LOG_LEVEL = "error";
delete process.env.REDIS_URL;
const safety = require("../../urlSafety"), calls = [], instances = new Map();
let failB = mode === "failure";
const now = Date.now();
const xmlDate = time => new Date(time).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
safety.safeFetch = async address => {
    const url = new URL(String(address)), host = url.hostname.startsWith("a.") ? "a" : "b";
    const action = url.searchParams.get("action") || "epg";
    calls.push([host, action]);
    if (mode === "m3u" && (url.pathname.endsWith(".m3u") || url.pathname.endsWith("/get.php"))) {
        return { ok: true, text: async () => `#EXTM3U\n#EXTINF:-1 group-title="Movies",${host} Movie\nhttps://${host}.example.com/movie.mp4\n#EXTINF:-1 group-title="Series",${host} Show S01E01\nhttps://${host}.example.com/episode.mp4\n` };
    }
    if (mode === "read") throw new Error("A warm restart must not fetch the provider");
    if (host === "b" && failB) throw new Error("Simulated provider outage");
    if (action === "get_live_streams") return json([{ stream_id: 1, name: `${host} Live`, epg_channel_id: "same.channel", category_id: 1 }]);
    if (action === "get_vod_streams") return json(Array.from({ length: 55 }, (_, index) => ({
        stream_id: index + 2, name: `${host} Movie ${index}`, container_extension: "mp4", tmdb_id: index + 123, category_id: 1
    })));
    if (action === "get_series") return json([{ series_id: 3, name: `${host} Series`, tmdb_id: 456, category_id: 1 }]);
    if (action.endsWith("_categories")) return json([{ category_id: 1, category_name: `${host} Category` }]);
    if (action === "get_series_info") return json({ info: {}, episodes: { 1: [{ id: 7, season: 1, episode_num: 1,
        title: `${host} Episode`, container_extension: "mp4", info: { duration_secs: 3600 } }] } });
    if (action === "epg") return { ok: true, status: 200, body: Readable.from([
        `<tv><programme channel="same.channel" start="${xmlDate(now - 3600000)}" stop="${xmlDate(now + 3600000)}"><title>${host} Programme</title></programme></tv>`
    ]) };
    throw new Error("Unexpected provider action " + action);
};
const createAddon = require("../../addon"), { M3UEPGAddon } = createAddon;
const { validateConfig } = require("../../configValidation");
const { qualify } = require("../../multiProviderAddon");
const tmdb = require("../../src/js/tmdbMetadata"), omdb = require("../../src/js/omdbMetadata");
const meta = type => ({ name: "Enriched " + type, description: "Full available description", poster: "https://example.com/poster.jpg",
    background: "https://example.com/background.jpg", logo: "https://example.com/logo.png", genres: ["Drama"],
    year: 2026, releaseInfo: "2026", runtime: "60 min", imdbId: "tt1234567", cast: ["Actor"], director: ["Director"],
    links: [{ name: "Writer", category: "Writers", url: "https://example.com/writer" }] });
tmdb.getMovieCatalogMetadata = async () => { await new Promise(resolve => setImmediate(resolve)); return meta("movie"); };
tmdb.getSeriesCatalogMetadata = async () => meta("series");
tmdb.getMovieMetadata = async (id, options = {}) => { options.onMetadata?.(meta("movie")); return meta("movie"); };
tmdb.getSeriesMetadata = async (id, options = {}) => { options.onMetadata?.(meta("series")); return meta("series"); };
tmdb.getSeasonEpisodes = async () => [{ season: 1, episode: 1, title: "Enriched Episode", description: "Episode overview", runtime: "60 min" }];
omdb.getByImdbId = async () => ({ imdbId: "tt1234567", imdbRating: "8.2", runtime: "60 min", omdbChecked: true, omdbCheckedAt: Date.now() });
const provider = require("../../src/js/providers/xtreamProvider"), fetchData = provider.fetchData;
provider.fetchData = async (addon, options) => { instances.set(new URL(addon.config.xtreamUrl).hostname[0], Object.getPrototypeOf(addon)); return fetchData(addon, options); };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
function source(host, extra = {}) {
    return { id: host.repeat(12), name: "Provider " + host.toUpperCase(), provider: "xtream", xtreamUrl: `https://${host}.example.com`,
        xtreamUsername: host, xtreamPassword: "test-password", enableEpg: true, ...extra };
}
let iface;
const catalog = (host, id) => qualify(host.repeat(12), id);
async function close(value) { if (value) await createAddon.disposeAddonInterface(value); }
(async () => {
    if (mode === "http") {
        const Module = require("module"), serverPath = path.resolve(__dirname, "../../server.js");
        process.env.CONFIG_SECRET = "test-only-secret-at-least-32-characters";
        process.env.SETUP_PASSWORD = "test-owner-password-at-least-16";
        process.env.PORT = "0";
        const mod = new Module(serverPath, module); mod.filename = serverPath; mod.paths = Module._nodeModulePaths(path.dirname(serverPath));
        mod._compile(fs.readFileSync(serverPath, "utf8") + "\nmodule.exports={server,storageReadyPromise,interfaceCache};", serverPath);
        await mod.exports.storageReadyPromise;
        if (!mod.exports.server.listening) await new Promise(resolve => mod.exports.server.once("listening", resolve));
        const origin = "http://127.0.0.1:" + mod.exports.server.address().port;
        const auth = "Basic " + Buffer.from("admin:" + process.env.SETUP_PASSWORD).toString("base64");
        const request = (url, options = {}) => fetch(origin + url, options);
        try {
            assert.strictEqual((await request("/html/multi-config.html")).status, 401);
            assert.strictEqual((await request("/configure-multi", { headers: { authorization: auth } })).status, 200);
            const encrypted = await request("/encrypt", { method: "POST", headers: { authorization: auth, "Content-Type": "application/json" },
                body: JSON.stringify({ sources: [source("a", { includeLive: false }), source("b", { includeMovies: false, includeSeries: false })] }) });
            assert.strictEqual(encrypted.status, 200); const token = encodeURIComponent((await encrypted.json()).token);
            const redirect = await request(`/${token}/configure`, { redirect: "manual" });
            assert.strictEqual(redirect.status, 302); assert(redirect.headers.get("location").endsWith("/configure-multi"));
            const saved = await (await request(`/${token}/configuration.json`)).json();
            assert.strictEqual(saved.sources.length, 2);
            const manifest = await (await request(`/${token}/manifest.json`)).json();
            assert.strictEqual(manifest.catalogs.length, 3);
            const page = await (await request(`/${token}/catalog/movie/${catalog("a", "iptv_movies")}.json`)).json();
            assert.strictEqual(page.metas.length, 50); assert(page.metas.every(item => item.description === "Full available description"));
            const details = await (await request(`/${token}/meta/movie/${page.metas[0].id}.json`, { headers: { "User-Agent": "Stremio iPhone" } })).json();
            assert.strictEqual(details.meta.description, "Full available description");
            const stream = await (await request(`/${token}/stream/movie/${page.metas[0].id}.json`)).json();
            assert(new URL(stream.streams[0].url).hostname.startsWith("a."));
        } finally {
            await new Promise(resolve => mod.exports.server.close(resolve));
            for (const [, active] of mod.exports.interfaceCache.entries()) await close(active);
            mod.exports.interfaceCache.clear();
        }
    } else if (mode === "m3u") {
        const config = validateConfig({ sources: [
            { id: "aaaaaaaaaaaa", name: "Direct", provider: "direct", m3uUrl: "https://a.example.com/list.m3u", includeLive: false },
            source("b", { xtreamUseM3U: true, includeLive: false })
        ] });
        iface = await createAddon(config);
        for (const host of ["a", "b"]) {
            const movies = await iface.get("catalog", "movie", catalog(host, "iptv_movies"));
            assert.strictEqual(movies.metas.length, 1);
            const movie = await iface.get("stream", "movie", movies.metas[0].id);
            assert(new URL(movie.streams[0].url).hostname.startsWith(host + "."));
            const shows = await iface.get("catalog", "series", catalog(host, "iptv_series"));
            const details = await iface.get("meta", "series", shows.metas[0].id);
            assert.strictEqual(details.meta.videos.length, 1);
            const episode = await iface.get("stream", "series", details.meta.videos[0].id);
            assert(new URL(episode.streams[0].url).hostname.startsWith(host + "."));
        }
    } else if (mode === "selection") {
        for (const selection of ["tv", "movie", "series"]) {
            calls.length = 0;
            const addon = new M3UEPGAddon(validateConfig(source("a", {
                includeLive: selection === "tv", includeMovies: selection === "movie", includeSeries: selection === "series", enableEpg: false
            })));
            addon.log = quiet;
            await provider.fetchData(addon);
            const streams = calls.filter(([, action]) => !action.includes("categories")).map(([, action]) => action);
            assert.deepStrictEqual(streams, [selection === "tv" ? "get_live_streams" : selection === "movie" ? "get_vod_streams" : "get_series"]);
            assert.strictEqual(addon.channels.length > 0, selection === "tv");
            assert.strictEqual(addon.movies.length > 0, selection === "movie");
            assert.strictEqual(addon.series.length > 0, selection === "series");
            await addon.dispose();
        }
        const config = validateConfig({ sources: [source("a", { includeLive: false }), source("b", { includeMovies: false, includeSeries: false })] });
        calls.length = 0; iface = await createAddon(config);
        assert.strictEqual(iface.manifest.catalogs.length, 3);
        assert(!calls.some(([host, action]) => host === "a" && /live|epg/.test(action)));
        assert(!calls.some(([host, action]) => host === "b" && /vod|series/.test(action)));
    } else {
        const config = validateConfig({ sources: [source("a"), source("b")] });
        iface = await createAddon(config);
        if (mode === "failure") {
            assert.strictEqual(iface.manifest.providerStatus[1].ready, false);
            assert.strictEqual((await iface.get("catalog", "movie", catalog("a", "iptv_movies"))).metas.length, 50);
            failB = false;
            const originalNow = Date.now;
            Date.now = () => originalNow() + 3601000;
            try { assert.strictEqual((await iface.get("catalog", "tv", catalog("b", "iptv_channels"))).metas.length, 1); }
            finally { Date.now = originalNow; }
            assert.strictEqual(iface.manifest.providerStatus[1].ready, true);
            const count = createAddon.getActiveInterfaceCount();
            const second = await createAddon(validateConfig({ sources: [{ ...config.sources[0], name: "Renamed" }] }));
            assert.strictEqual(createAddon.getActiveInterfaceCount(), count, "shared sources must use one writer");
            await close(iface); iface = second;
            assert.strictEqual((await iface.get("catalog", "movie", catalog("a", "iptv_movies"))).metas.length, 50);
        } else {
            assert.strictEqual(iface.manifest.catalogs.length, 6);
            const pages = [];
            for (const host of ["a", "b"]) {
                const page = await iface.get("catalog", "movie", catalog(host, "iptv_movies"));
                assert.strictEqual(page.metas.length, 50);
                for (const item of page.metas) {
                    assert.strictEqual(item.description, "Full available description");
                    assert.strictEqual(item.runtime, "60 min"); assert.strictEqual(item.year, 2026);
                    assert.deepStrictEqual(item.cast, ["Actor"]); assert.strictEqual(item.imdbRating, "8.2");
                }
                pages.push(page);
                const next = await iface.get("catalog", "movie", catalog(host, "iptv_movies"), { skip: 50 });
                assert.strictEqual(next.metas.length, 5); assert(next.metas.every(item => item.description));
                const search = await iface.get("catalog", "movie", catalog(host, "iptv_movies"), { search: "Movie" });
                assert.strictEqual(search.metas.length, 50); assert(search.metas.every(item => item.description));
                const movieStream = await iface.get("stream", "movie", page.metas[0].id);
                assert(new URL(movieStream.streams[0].url).hostname.startsWith(host + "."));
                const series = (await iface.get("catalog", "series", catalog(host, "iptv_series"))).metas[0];
                const detail = (await iface.get("meta", "series", series.id)).meta;
                assert.strictEqual(detail.description, "Full available description");
                assert.strictEqual(detail.videos.length, 1);
                const episode = await iface.get("stream", "series", detail.videos[0].id);
                assert(new URL(episode.streams[0].url).hostname.startsWith(host + "."));
                const guide = await iface.get("catalog", "tv", catalog(host, "iptv_channels"), { date: new Date(now).toISOString().slice(0, 10) });
                assert.strictEqual(guide.metasDetailed.length, 1);
                assert.strictEqual(guide.metasDetailed[0].videos[0].title, `${host} Programme`);
                assert(guide.metasDetailed[0].id.startsWith(`iptv_src_${host.repeat(12)}_`));
            }
            assert.notStrictEqual(pages[0].metas[0].id, pages[1].metas[0].id);
            assert.deepStrictEqual(await iface.get("stream", "movie", "iptv_vod_2"), { streams: [] });
            if (mode === "integration") {
                failB = true;
                const before = instances.get("b").lastUpdate;
                await instances.get("b").updateData(true);
                assert.strictEqual(instances.get("b").lastUpdate, before);
                assert.strictEqual((await iface.get("catalog", "movie", catalog("a", "iptv_movies"))).metas.length, 50);
                assert.strictEqual((await iface.get("catalog", "movie", catalog("b", "iptv_movies"))).metas.length, 50);
            }
            if (mode === "read") assert.strictEqual(calls.length, 0, "provider snapshots and episode details must survive a fresh process");
        }
    }
    await close(iface); iface = null;
    await createAddon.closeRedisClient();
    assert.strictEqual(createAddon.getActiveInterfaceCount(), 0);
    console.log("PASS multi-provider " + mode);
})().catch(async error => { console.error(error); try { await close(iface); } catch {} process.exitCode = 1; })
    .finally(() => { if (!process.argv[3]) fs.rmSync(directory, { recursive: true, force: true }); });
