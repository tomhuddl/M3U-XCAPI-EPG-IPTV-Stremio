const { getRouter } = require("stremio-addon-sdk");
const createAddon = require("./addon");
const context = require("./requestContext");
const { projectResponse } = require("./publicMetadata");
const responseCompression = require("./responseCompression");
const routers = new WeakMap();
const builds = new Map();

// NOTE: In a serverless environment, cold starts will rebuild & preload every time.
// You may wish to add a timeout guard or skip full preload if execution time is tight.

let cachedInterface = null;
let cachedConfigKey = null;

async function getInterface(eventConfig = {}) {
    const key = JSON.stringify(eventConfig);
    if (cachedInterface && cachedConfigKey === key) {
        return cachedInterface;
    }
    let build = builds.get(key);
    if (!build) {
        build = Promise.resolve().then(() => createAddon(eventConfig)).finally(() => builds.delete(key));
        builds.set(key, build);
    }
    cachedInterface = await build;
    cachedConfigKey = key;
    return cachedInterface;
}

module.exports = async function (req, res) {
    try {
        // This simplistic serverless handler does not parse per-request configs via URL like server.js.
        // If you want dynamic configs in serverless, you'd replicate the logic from server.js here.
        const addonInterface = await getInterface();
        let router = routers.get(addonInterface);
        if (!router) {
            router = getRouter({ manifest: addonInterface.manifest,
                get: (...args) => addonInterface.get(...args).then(body => projectResponse(body, context.current())) });
            routers.set(addonInterface, router);
        }
        const agent = String(req.headers["user-agent"] || "").toLowerCase();
        if (/\/(?:meta|catalog)\/(?:movie|series)\//.test(req.url))
            res.setHeader("Cache-Control", "no-store, private");
        responseCompression(req, res, () => context.run({ priority: "foreground",
            ios: agent.includes("stremio") && /iphone|ipad|ipod|ios/.test(agent) }, () => router(req, res, function () {
            res.statusCode = 404;
            res.end();
        })));
    } catch (e) {
        console.error('[SERVERLESS] Error:', e && e.name ? e.name : 'Error');
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Serverless addon error' }));
    }
};
