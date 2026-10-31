"use strict";
const fs = require("fs"),
    path = require("path"),
    Module = require("module"),
    assert = require("assert");
const { PassThrough, Readable } = require("stream");
const root = path.resolve(__dirname, "../..");
const temp = path.join(
    root,
    ".test-tmp",
    "audit-" + process.argv[2] + "-" + process.pid
);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};
const load = (name) => require(path.join(root, name));
process.env.LOG_LEVEL = "error";
process.env.PERSISTENT_DATA_DIR = temp;
delete process.env.REDIS_URL;
delete process.env.TMDB_API_KEY;
delete process.env.OMDB_API_KEY;
const probes = {
    async recoveryInterrupted() {
        const Journal = load("persistentMapJournal"),
            file = path.join(temp, "recovery.json");
        const journal = new Journal(file, 1024 * 1024),
            entries = new Map([["a", { value: "old" }]]);
        journal.mark("a", entries.get("a"));
        const append = fs.promises.appendFile,
            read = fs.promises.readFile;
        let appends = 0;
        fs.promises.readFile = async (...args) => {
            if (args[0] === file + ".wal")
                throw Object.assign(new Error("Read unavailable"), {
                    code: "EIO"
                });
            return read(...args);
        };
        fs.promises.appendFile = async (...args) => {
            appends++;
            await append(...args);
            entries.set("a", { value: "new" });
            journal.mark("a", entries.get("a"));
            throw Object.assign(new Error("Partial write"), { code: "ENOSPC" });
        };
        try {
            await assert.rejects(journal.flush(entries));
            await assert.rejects(journal.flush(entries));
            assert.strictEqual(appends, 1);
        } finally {
            fs.promises.appendFile = append;
            fs.promises.readFile = read;
        }
        await journal.flush(entries);
        const restored = await new Journal(file, 1024 * 1024).load();
        assert.strictEqual(restored.entries.get("a").value, "new");
        return { unsafeAppendsPrevented: true };
    },
    async dnsAbort() {
        require("dns").promises.lookup = async () => new Promise(() => {});
        const controller = new AbortController();
        const pending = load("urlSafety").safeFetch(
            "https://example.com/never-resolves",
            { signal: controller.signal }
        );
        await tick();
        controller.abort();
        const result = await Promise.race([
            pending.then(
                () => "unexpected",
                (error) => error.name
            ),
            delay(100).then(() => "still waiting for DNS")
        ]);
        assert.strictEqual(result, "AbortError");
        return { result };
    },
    async trailerRetention() {
        process.env.TMDB_API_KEY = "test";
        load("urlSafety").safeFetch = async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ results: [null] })
        });
        const old = {
            tmdbId: "123",
            checkedAt: Date.now() - 15 * 86400000,
            trailer: { id: "saved", title: "Saved trailer", site: "YouTube" }
        };
        const result = await load("src/js/tmdbMetadata").getMovieMetadata(
            "123",
            { cachedMetadata: { name: "Example" }, detailExtras: old }
        );
        assert.strictEqual(result.trailer.id, "saved");
        assert.strictEqual(result._detailExtras.failed, true);
        return { retained: result.trailer.id };
    },
    async fallbackException() {
        const { M3UEPGAddon } = load("addon"),
            addon = new M3UEPGAddon({
                provider: "direct",
                m3uUrl: "https://example.com/list.m3u"
            });
        const item = {
            id: "iptv_vod_2",
            type: "movie",
            name: "Example",
            tmdbId: "123"
        };
        addon.movies = [item];
        addon.lastUpdate = 1;
        const saved = {
            ...item,
            _tmdbId: "123",
            metadataVersion: 3,
            description: "Keep me",
            poster: "https://example.com/p.jpg",
            background: "https://example.com/b.jpg",
            year: 2024,
            genres: ["Drama"],
            runtime: "60 min",
            imdbId: "tt1234567",
            imdbRating: "8.0",
            cast: ["Actor"],
            director: ["Director"],
            metadataCheckedAt: Date.now() - 15 * 86400000,
            missingMetadataCheckedAt: Date.now() - 13 * 3600000
        };
        const entries = new Map([
            [item.id, { value: saved, savedAt: saved.metadataCheckedAt }]
        ]);
        addon.persistentCatalogMetaCache = {
            get: async (id) => entries.get(id),
            set: async (id, value) =>
                entries.set(id, { value, savedAt: Date.now() })
        };
        let calls = 0;
        load("src/js/tmdbMetadata").getMovieCatalogMetadata = async () => {
            calls++;
            throw new TypeError("Controlled source failure");
        };
        for (let n = 0; n < 2; n++) {
            const result = await addon.enrichCatalogMetaItems([item]);
            assert.strictEqual(result.get(item.id).description, "Keep me");
        }
        assert.strictEqual(calls, 1);
        assert(entries.get(item.id).value.metadataRefreshAttemptedAt > 0);
        return { calls };
    },
    async epgSpecialIds() {
        const parser = load("src/js/epgStreamParser"),
            { mergeEpgSources } = load("src/js/providers/epgUtils");
        const xml =
            "<tv>" +
            ["constructor", "__proto__"]
                .map(
                    (id) =>
                        '<programme channel="' +
                        id +
                        '" start="20261031010000 +0000" stop="20261031020000 +0000"><title>Guide</title></programme>'
                )
                .join("") +
            "</tv>";
        const parsed = await parser.parseEPGStream(Readable.from([xml]));
        const addon = { log: quiet };
        const merged = mergeEpgSources(addon, [parsed]);
        assert.strictEqual(merged.constructor.length, 1);
        assert.strictEqual(merged.__proto__.length, 1);
        assert.strictEqual(Object.getPrototypeOf(merged), Object.prototype);
        return { channels: Object.keys(merged) };
    },
    async trailers() {
        process.env.TMDB_API_KEY = "test";
        const gate = deferred(),
            unhandled = [];
        process.on("unhandledRejection", (error) => unhandled.push(error));
        load("urlSafety").safeFetch = async (url) => ({
            ok: true,
            status: 200,
            text: async () => {
                if (new URL(url).pathname.endsWith("/videos"))
                    return JSON.stringify({ results: [null] });
                await gate.promise;
                return JSON.stringify({
                    id: 123,
                    title: "Example",
                    genres: [null],
                    credits: { cast: [null], crew: [null] }
                });
            }
        });
        const tmdb = load("src/js/tmdbMetadata");
        const pending = tmdb.getMovieMetadata("123");
        await delay(30);
        assert.strictEqual(unhandled.length, 0);
        gate.resolve();
        const result = await pending;
        assert.strictEqual(result.name, "Example");
        assert.doesNotThrow(() =>
            tmdb.mapSeasonEpisodes(
                {
                    episodes: [
                        null,
                        { episode_number: 1, guest_stars: [null], crew: [null] }
                    ]
                },
                1
            )
        );
        return { name: result.name, unhandled: unhandled.length };
    },
    async launcher() {
        const source = await fs.promises.readFile(
            path.join(root, "Start-Addon.bat"),
            "utf8"
        );
        assert(source.includes("call npm ci --omit=dev"));
        assert(!source.includes("taskkill"));
        assert(source.includes("node server.js"));
        if (process.platform === "win32") {
            const bin = path.join(temp, "bin");
            await fs.promises.mkdir(bin, { recursive: true });
            await fs.promises.writeFile(
                path.join(bin, "npm.cmd"),
                "@echo off\r\nmkdir node_modules\r\necho NPM_INSTALLED\r\nexit /b 0\r\n"
            );
            await fs.promises.writeFile(
                path.join(bin, "node.cmd"),
                "@echo off\r\necho NODE_STARTED\r\nexit /b 0\r\n"
            );
            const target = path.join(temp, "Start-Addon.bat");
            await fs.promises.copyFile(
                path.join(root, "Start-Addon.bat"),
                target
            );
            const env = { ...process.env };
            for (const key of Object.keys(env))
                if (key.toLowerCase() === "path") delete env[key];
            env.Path = bin + ";" + process.env.PATH;
            const run = require("child_process").spawnSync(
                "cmd.exe",
                ["/d", "/q", "/c", target],
                {
                    cwd: temp,
                    env,
                    encoding: "utf8",
                    timeout: 3000,
                    windowsHide: true
                }
            );
            assert.strictEqual(run.status, 0, run.stdout + run.stderr);
            assert.match(run.stdout, /NPM_INSTALLED[\s\S]*NODE_STARTED/);
        }
        return { safeInstall: true, forceKillRemoved: true };
    },
    async errorbody() {
        process.env.OMDB_API_KEY = "test";
        const safety = load("urlSafety"),
            body = new PassThrough();
        safety.safeFetch = async () => ({ ok: false, status: 429, body });
        await load("src/js/omdbMetadata").getByImdbId("tt1234567");
        const result = {
            destroyed: body.destroyed,
            readableFlowing: body.readableFlowing
        };
        body.destroy();
        assert.strictEqual(result.destroyed, true);
        assert.strictEqual(result.readableFlowing, null);
        return result;
    },
    async journal() {
        await fs.promises.mkdir(temp, { recursive: true });
        const Journal = load("persistentMapJournal"),
            file = path.join(temp, "map.json");
        const journal = new Journal(file, 1024 * 1024),
            entries = new Map([
                ["a", { value: "old" }],
                ["b", { value: "other" }]
            ]);
        for (const [k, v] of entries) journal.mark(k, v);
        const append = fs.promises.appendFile;
        fs.promises.appendFile = async (name, payload, options) => {
            await append(name, payload.split("\n")[0] + "\n", options);
            entries.set("a", { value: "new" });
            journal.mark("a", entries.get("a"));
            throw Object.assign(new Error("Simulated partial disk write"), {
                code: "ENOSPC"
            });
        };
        try {
            await journal.flush(entries);
        } catch (e) {
            assert.strictEqual(e.code, "ENOSPC");
        } finally {
            fs.promises.appendFile = append;
        }
        await journal.flush(entries);
        const restored = await new Journal(file, 1024 * 1024).load();
        assert.strictEqual(restored.entries.get("a").value, "new");
        return {
            inMemory: entries.get("a"),
            restored: restored.entries.get("a"),
            journal: await fs.promises.readFile(file + ".wal", "utf8")
        };
    },
    async redis() {
        const redisModule = require.resolve("ioredis");
        const EventEmitter = require("events");
        class Redis extends EventEmitter {
            connect() {
                return Promise.resolve();
            }
            get() {
                return new Promise(() => {});
            }
            set() {
                return new Promise(() => {});
            }
        }
        require.cache[redisModule] = {
            id: redisModule,
            filename: redisModule,
            loaded: true,
            exports: { Redis }
        };
        process.env.REDIS_URL = "redis://example.invalid:6379";
        const { M3UEPGAddon } = load("addon");
        const addon = new M3UEPGAddon({
            provider: "direct",
            m3uUrl: "https://example.com/list.m3u"
        });
        let diskLoads = 0,
            diskSaves = 0,
            loadDone = false,
            saveDone = false;
        addon.persistentAddonDataCache.load = async () => {
            diskLoads++;
            return {
                channels: [],
                movies: [],
                series: [],
                epgData: {},
                lastUpdate: 1
            };
        };
        addon.persistentAddonDataCache.save = async () => {
            diskSaves++;
        };
        addon.loadFromCache().then(() => (loadDone = true));
        addon.saveToCache().then(() => (saveDone = true));
        await delay(50);
        assert.strictEqual(diskLoads, 1);
        assert.strictEqual(diskSaves, 1);
        assert.strictEqual(loadDone, true);
        await delay(1100);
        assert.strictEqual(saveDone, true);
        return { diskLoads, diskSaves, loadDone, saveDone };
    },
    async shutdown() {
        const { M3UEPGAddon } = load("addon"),
            addon = new M3UEPGAddon({
                provider: "direct",
                m3uUrl: "https://example.com/list.m3u"
            });
        const gate = deferred();
        addon.catalogPrefetchJobs.set("series", gate.promise);
        const flushed = [];
        for (const name of [
            "persistentAddonDataCache",
            "persistentCatalogMetaCache",
            "persistentSeriesInfoCache"
        ])
            addon[name].flush = async () => flushed.push(name);
        let disposed = false;
        const pending = addon.dispose().then(() => (disposed = true));
        await delay(30);
        const before = { disposed, flushed: [...flushed] };
        gate.resolve();
        await pending;
        assert.strictEqual(before.disposed, false);
        assert.strictEqual(before.flushed.length, 3);
        assert.strictEqual(flushed.length, 6);
        return { before, after: { disposed, flushed } };
    },
    async queue() {
        const nf = require.resolve("node-fetch"),
            bodies = [];
        require.cache[nf] = {
            id: nf,
            filename: nf,
            loaded: true,
            exports: async (url, opts) => {
                const body = new PassThrough();
                bodies.push(body);
                opts.signal.addEventListener("abort", () => body.destroy(), {
                    once: true
                });
                return { status: 200, body };
            }
        };
        const { safeFetch } = load("urlSafety");
        await Promise.all(
            Array.from({ length: 12 }, () =>
                safeFetch("https://8.8.8.8/hold", { timeout: 5000 })
            )
        );
        const controller = new AbortController();
        let completed = false;
        const queued = safeFetch("https://8.8.8.8/queued", {
            timeout: 5,
            signal: controller.signal
        }).then(
            () => {
                completed = true;
                return "ok";
            },
            (e) => {
                completed = true;
                return e.name;
            }
        );
        controller.abort();
        await delay(40);
        const beforeRelease = { completed, networkCalls: bodies.length };
        bodies[0].destroy();
        const outcome = await queued;
        bodies.forEach((b) => b.destroy());
        assert.strictEqual(beforeRelease.completed, true);
        assert.strictEqual(outcome, "AbortError");
        return { beforeRelease, outcome };
    },
    async playlist() {
        const { M3UEPGAddon } = load("addon");
        const addon = new M3UEPGAddon({
            provider: "direct",
            m3uUrl: "https://example.com/list.m3u"
        });
        const text = [
            "#EXTM3U",
            '#EXTINF:-1 group-title="Entertainment",BBC One HD',
            "https://example.com/1",
            '#EXTINF:-1 group-title="Series",Example S01E01 4K',
            "https://example.com/2",
            '#EXTINF:-1 group-title="Series",Example S01E100',
            "https://example.com/3",
            '#EXTINF:42.5 group-title="Movies",Fractional Duration',
            "https://example.com/4",
            '#EXTINF:-1 group-title="Movies",Movie, The',
            "https://example.com/5"
        ].join("\n");
        const parsed = addon
            .parseM3U(text)
            .map(({ name, type }) => ({ name, type }));
        assert.strictEqual(parsed[0].type, "tv");
        assert.strictEqual(parsed[1].type, "series");
        assert(parsed.some((p) => p.name === "Fractional Duration"));
        assert(parsed.some((p) => p.name === "Movie, The"));
        return parsed;
    },
    async m3useries() {
        const safety = load("urlSafety"),
            urls = [];
        safety.safeFetch = async (url) => {
            urls.push(url);
            return {
                ok: true,
                text: async () =>
                    '#EXTM3U\n#EXTINF:-1 group-title="Series",Example S01E01\nhttps://example.com/episode.mp4',
                json: async () => ({ episodes: {} })
            };
        };
        const { M3UEPGAddon } = load("addon"),
            provider = load("src/js/providers/xtreamProvider");
        const addon = new M3UEPGAddon({
            provider: "xtream",
            xtreamUseM3U: true,
            includeSeries: true,
            enableEpg: false,
            xtreamUrl: "https://example.com",
            xtreamUsername: "dummy",
            xtreamPassword: "dummy"
        });
        await provider.fetchData(addon, { skipEpg: true });
        const details = await provider.fetchSeriesInfo(
            addon,
            addon.series[0].series_id
        );
        assert.strictEqual(addon.directSeriesEpisodeIndex.size, 1);
        assert.strictEqual(details.videos.length, 1);
        assert.strictEqual(urls.length, 1);
        return {
            series: addon.series.map(({ id, series_id, name }) => ({
                id,
                series_id,
                name
            })),
            episodeIndexSize: addon.directSeriesEpisodeIndex.size,
            videos: details.videos.length,
            requestedSeriesId: null
        };
    },
    async epg() {
        const parser = load("src/js/epgStreamParser"),
            budget = {
                programmes: parser.MAX_PROGRAMMES_TOTAL - 1,
                textChars: 0
            };
        const xml =
            "<tv>" +
            [1, 2, 3]
                .map(
                    (i) =>
                        `<programme channel="x" start="20261031010000 +0000" stop="20261031020000 +0000"><title>${i}</title></programme>`
                )
                .join("") +
            "</tv>";
        const result = await parser.parseEPGStream(
            Readable.from([xml]),
            new Set(["x"]),
            budget
        );
        assert.strictEqual(parser.getEPGStatus(result).truncated, true);
        assert.strictEqual(parser.getEPGStatus(result).omittedProgrammes, 2);
        assert.strictEqual(result.x.length, 1);
        return {
            supplied: 3,
            retained: result.x.length,
            resultKeys: Object.keys(result),
            budget
        };
    },
    async fallback() {
        const { M3UEPGAddon } = load("addon"),
            addon = new M3UEPGAddon({
                provider: "direct",
                m3uUrl: "https://example.com/list.m3u"
            });
        const item = {
            id: "iptv_vod_2",
            type: "movie",
            name: "Example",
            tmdbId: "123"
        };
        addon.movies = [item];
        addon.lastUpdate = 123;
        const saved = {
            id: item.id,
            type: "movie",
            name: "Example",
            description: "Saved description",
            poster: "https://example.com/poster.jpg",
            metadataVersion: 3,
            metadataCheckedAt: Date.now() - 15 * 86400000
        };
        addon.persistentCatalogMetaCache.get = async () => ({
            value: saved,
            savedAt: saved.metadataCheckedAt
        });
        const tmdb = load("src/js/tmdbMetadata");
        tmdb.getMovieCatalogMetadata = async () =>
            tmdb.mapMovieMetadata({ title: "Example" }, { cast: [null] });
        const result = await addon.enrichCatalogMetaItems([item]);
        assert.strictEqual(result.size, 1);
        assert.strictEqual(result.get(item.id).description, saved.description);
        return {
            savedDescription: saved.description,
            pagePreviews: result.size
        };
    },
    async quota() {
        await fs.promises.mkdir(temp, { recursive: true });
        const NativeDate = Date;
        let now = NativeDate.parse("2026-10-31T23:59:59Z");
        global.Date = class extends NativeDate {
            constructor(...args) {
                super(...(args.length ? args : [now]));
            }
            static now() {
                return now;
            }
        };
        await fs.promises.writeFile(
            path.join(temp, "omdb-usage.json"),
            JSON.stringify({ day: "2026-10-31", count: 1 })
        );
        const gate = deferred(),
            started = deferred(),
            rename = fs.promises.rename;
        fs.promises.rename = async (...args) => {
            started.resolve();
            await gate.promise;
            return rename(...args);
        };
        process.env.OMDB_API_KEY = "test";
        process.env.OMDB_DAILY_REQUEST_LIMIT = "2";
        process.env.OMDB_DAILY_RESERVATION_BLOCK_SIZE = "2";
        const safety = load("urlSafety");
        let calls = 0;
        safety.safeFetch = async () => {
            calls++;
            return {
                ok: true,
                json: async () => ({
                    Response: "True",
                    imdbRating: "8",
                    Runtime: "60 min"
                })
            };
        };
        const omdb = load("src/js/omdbMetadata");
        const first = omdb.getByImdbId("tt1234567");
        await started.promise;
        now = NativeDate.parse("2026-11-01T00:00:01Z");
        const second = omdb.getByImdbId("tt1234568");
        await tick();
        gate.resolve();
        await Promise.all([first, second]);
        await omdb.getByImdbId("tt1234569");
        const result = {
            actualCallsOnNewDay: calls,
            diskCounter: JSON.parse(
                await fs.promises.readFile(
                    path.join(temp, "omdb-usage.json"),
                    "utf8"
                )
            ),
            diagnostics: omdb.getDiagnostics()
        };
        global.Date = NativeDate;
        fs.promises.rename = rename;
        assert.strictEqual(calls, 2);
        assert.strictEqual(result.diskCounter.day, "2026-11-01");
        return result;
    },
    async polling() {
        const vm = require("vm"),
            elements = new Map(),
            requests = [],
            timers = [];
        let now = 0;
        const getElement = (id) => {
            if (!elements.has(id))
                elements.set(id, {
                    style: { width: "0%" },
                    classList: { add() {}, remove() {} },
                    addEventListener() {},
                    textContent: "",
                    parentElement: { appendChild() {} }
                });
            return elements.get(id);
        };
        const window = {
            location: {
                origin: "https://example.com",
                protocol: "https:",
                pathname: "/configure-direct"
            }
        };
        const context = {
            window,
            document: {
                getElementById: getElement,
                createElement: () => getElement("created")
            },
            Date: { now: () => now },
            setTimeout: (f, ms) => {
                timers.push({ f, ms });
                return timers.length;
            },
            clearTimeout() {},
            navigator: {},
            fetch: (url, opts) => {
                requests.push({ url, opts });
                return new Promise(() => {});
            },
            URL,
            AbortController,
            TextEncoder,
            TextDecoder,
            console
        };
        vm.runInNewContext(
            fs.readFileSync(
                path.join(root, "src/js/configure-common.js"),
                "utf8"
            ),
            context
        );
        const api = window.ConfigureCommon;
        if (!api) return { exported: Object.keys(window) };
        api.showOverlay();
        api.startPolling(50);
        now = 120000;
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(timers.length, 1);
        return {
            requests: requests.length,
            hasAbortSignal: Boolean(requests[0]?.opts.signal),
            timers: timers.length,
            progress: getElement("progressText").textContent
        };
    },
    async pollrace() {
        const vm = require("vm"),
            elements = new Map(),
            gates = [],
            tokens = ["enc:first", "enc:second"];
        let tokenIndex = 0;
        const element = (id) => {
            if (!elements.has(id))
                elements.set(id, {
                    style: { width: "0%" },
                    classList: { add() {}, remove() {} },
                    addEventListener() {},
                    textContent: "",
                    parentElement: { appendChild() {} }
                });
            return elements.get(id);
        };
        const window = {
            location: {
                origin: "https://example.com",
                protocol: "https:",
                pathname: "/configure-direct"
            }
        };
        const context = {
            window,
            document: {
                getElementById: element,
                createElement: () => element("created")
            },
            Date,
            setTimeout: () => 1,
            clearTimeout() {},
            navigator: {},
            URL,
            AbortController,
            TextEncoder,
            TextDecoder,
            console,
            fetch: (url) => {
                if (url === "/encrypt")
                    return Promise.resolve({
                        ok: true,
                        json: async () => ({ token: tokens[tokenIndex++] })
                    });
                const gate = deferred();
                gates.push({ url, ...gate });
                return gate.promise;
            }
        };
        vm.runInNewContext(
            fs.readFileSync(
                path.join(root, "src/js/configure-common.js"),
                "utf8"
            ),
            context
        );
        const api = window.ConfigureCommon;
        await api.buildUrls({});
        api.showOverlay();
        api.startPolling();
        api.hideOverlay();
        await api.buildUrls({});
        api.showOverlay();
        api.startPolling();
        gates[0].resolve({
            ok: true,
            json: async () => ({ id: "old-manifest" })
        });
        await tick();
        const result = {
            newManifestStillPending: true,
            oldResponseEnabledNewOpenButton:
                !element("openStremioBtn").disabled,
            progress: element("progressText").textContent
        };
        assert.strictEqual(result.oldResponseEnabledNewOpenButton, false);
        return result;
    },
    async preflight() {
        const http = require("http"),
            safety = load("urlSafety");
        const xml =
            '<html><programme channel="x">This is not XMLTV</programme></html>';
        safety.safeFetch = async () => ({
            ok: true,
            status: 200,
            body: Readable.from([Buffer.from(xml)])
        });
        const addonPath = require.resolve(path.join(root, "addon"));
        const fake = async () => {
            throw new Error("No configuration build allowed");
        };
        Object.assign(fake, {
            disposeAddonInterface: async () => {},
            flushAddonDisposals: async () => {},
            closeRedisClient: async () => {}
        });
        require.cache[addonPath] = {
            id: addonPath,
            filename: addonPath,
            loaded: true,
            exports: fake
        };
        const serverPath = path.join(root, "server.js"),
            mod = new Module(serverPath, module);
        mod.filename = serverPath;
        mod.paths = Module._nodeModulePaths(root);
        const source = fs
            .readFileSync(serverPath, "utf8")
            .replace(
                /const server = app\.listen\(port, \(\) => \{[\s\S]*?\n\}\);/,
                "const server = { close(resolve) { resolve(); } };"
            );
        mod._compile(
            source + "\nmodule.exports={app,storageReadyPromise};",
            serverPath
        );
        await mod.exports.storageReadyPromise;
        const result = await new Promise((resolve, reject) => {
            const req = new http.IncomingMessage({
                remoteAddress: "127.0.0.1"
            });
            req.method = "POST";
            req.url = "/api/epg-stats";
            req.headers = { host: "addon.example" };
            req.body = { url: "https://example.com/guide.xml" };
            const res = new http.ServerResponse(req);
            res.end = function (chunk) {
                this.finished = true;
                this.emit("finish");
                resolve({
                    status: this.statusCode,
                    body: JSON.parse(String(chunk))
                });
                return this;
            };
            mod.exports.app.handle(req, res, reject);
        });
        let realParserError;
        try {
            await load("src/js/epgStreamParser").parseEPGStream(
                Readable.from([xml])
            );
        } catch (e) {
            realParserError = e.message;
        }
        assert.strictEqual(result.status, 502);
        assert(realParserError);
        return { preflight: result, realParserError };
    }
};
(async () => {
    await fs.promises.mkdir(temp, { recursive: true });
    if (!probes[process.argv[2]]) throw new Error("Unknown probe");
    const value = await probes[process.argv[2]]();
    console.log("AUDIT_RESULT " + JSON.stringify(value));
    process.exit(0);
})().catch((e) => {
    console.error(e.stack);
    process.exit(1);
});
