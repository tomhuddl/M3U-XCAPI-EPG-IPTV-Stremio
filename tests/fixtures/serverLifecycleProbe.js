"use strict";
const fs = require("fs"),
    path = require("path"),
    Module = require("module"),
    assert = require("assert");
const root = path.resolve(__dirname, "../..");
const mode = process.argv[2];
const directory = path.join(
    root,
    ".test-tmp",
    "server-lifecycle-" + mode + "-" + process.pid
);
fs.mkdirSync(directory, { recursive: true });
process.env.PERSISTENT_DATA_DIR = directory;
process.env.CONFIG_SECRET = "test-server-lifecycle-secret-not-for-deployment";
process.env.PORT = "0";
process.env.LOG_LEVEL = "error";
process.env.SHUTDOWN_TIMEOUT_MS = "1000";
process.env.SETUP_PASSWORD = "owner-test-password-at-least-16";
delete process.env.REDIS_URL;
delete process.env.TMDB_API_KEY;
delete process.env.OMDB_API_KEY;
if (mode === "invalid-storage") {
    const file = path.join(directory, "file");
    fs.writeFileSync(file, "not a directory");
    process.env.PERSISTENT_DATA_DIR = file;
}
const actual = require(path.join(root, "addon"));
const instance = new actual.M3UEPGAddon({
    provider: "direct",
    m3uUrl: "https://example.com/list.m3u"
});
const flushed = [];
for (const name of [
    "persistentAddonDataCache",
    "persistentCatalogMetaCache",
    "persistentSeriesInfoCache"
])
    instance[name].flush = async () => flushed.push(name);
let releaseJob;
if (mode === "deadline")
    instance.catalogPrefetchJobs.set(
        "series",
        new Promise((resolve) => {
            releaseJob = resolve;
        })
    );
const iface = {
    manifest: {
        id: "lifecycle.test",
        version: "1.0.0",
        name: "Lifecycle test",
        catalogs: [],
        types: ["movie"],
        resources: ["meta", "stream"]
    },
    get: async (resource, type, id) =>
        resource === "stream"
            ? { streams: [{ url: "https://example.com/video.mp4" }] }
            : {
                  meta: {
                      id,
                      type,
                      name: "Saved title",
                      links: [
                          {
                              name: "Writer",
                              category: "Writers",
                              url: "https://example.com/writer"
                          }
                      ]
                  }
              }
};
const create = async () => iface;
Object.assign(create, {
    createInterfaceKey: actual.createInterfaceKey,
    acquireAddonInterface: () => instance.acquireRequest(),
    releaseAddonInterface: () => instance.releaseRequest(),
    disposeAddonInterface: () => instance.dispose(),
    flushAddonDisposals: async () => {},
    flushActiveAddonCaches: () =>
        Promise.allSettled([instance.flushPersistentStores()]),
    closeRedisClient: async () => {},
    getActiveInterfaceCount: () => 1
});
require.cache[require.resolve(path.join(root, "addon"))].exports = create;
const serverPath = path.join(root, "server.js"),
    mod = new Module(serverPath, module);
mod.filename = serverPath;
mod.paths = Module._nodeModulePaths(root);
mod._compile(
    fs.readFileSync(serverPath, "utf8") +
        "\nmodule.exports={app,server,shutdown,storageReadyPromise};",
    serverPath
);
let started = Date.now();
process.on("exit", (code) => {
    fs.writeSync(
        1,
        "LIFECYCLE_RESULT " +
            JSON.stringify({
                mode,
                code,
                flushed: flushed.length,
                elapsed: Date.now() - started
            }) +
            "\n"
    );
});
(async () => {
    await mod.exports.storageReadyPromise;
    if (mode === "invalid-storage") return;
    if (!mod.exports.server.listening)
        await new Promise((resolve) =>
            mod.exports.server.once("listening", resolve)
        );
    const origin = "http://127.0.0.1:" + mod.exports.server.address().port;
    const request = async (route, options) => fetch(origin + route, options);
    assert.strictEqual((await request("/health")).status, 200);
    assert.strictEqual(
        (await request("/encrypt", { method: "POST" })).status,
        401
    );
    const authorization =
        "Basic " +
        Buffer.from("admin:" + process.env.SETUP_PASSWORD).toString("base64");
    const response = await request("/encrypt", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization },
        body: JSON.stringify({
            provider: "direct",
            m3uUrl: "https://example.com/list.m3u"
        })
    });
    assert.strictEqual(response.status, 200);
    const { token } = await response.json();
    const manifest = await request("/" + token + "/manifest.json");
    assert.strictEqual(manifest.status, 200);
    const ios = await request("/" + token + "/meta/movie/iptv_vod_2.json", {
        headers: { "User-Agent": "Stremio iOS iPhone" }
    });
    const windows = await request("/" + token + "/meta/movie/iptv_vod_2.json", {
        headers: { "User-Agent": "Stremio Windows" }
    });
    assert.strictEqual((await ios.json()).meta.links.length, 1);
    assert.strictEqual((await windows.json()).meta.links.length, 0);
    assert.match(windows.headers.get("Cache-Control"), /no-store/);
    assert.match(
        windows.headers.get("Content-Security-Policy"),
        /script-src 'self';/
    );
    const support = await request("/support.html");
    assert.match(await support.text(), /data-slug="K3QSoR2"/);
    assert.match(
        support.headers.get("Content-Security-Policy"),
        /script-src 'self' https:\/\/cdnjs.buymeacoffee.com/
    );
    started = Date.now();
    await mod.exports.shutdown("Lifecycle test");
})().catch((error) => {
    console.error(error.stack);
    releaseJob?.();
    process.exit(2);
});
