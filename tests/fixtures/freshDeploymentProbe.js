"use strict";
const assert = require("assert"),
    fs = require("fs/promises"),
    path = require("path");
const { Readable } = require("stream");
const root = path.resolve(__dirname, "../..");
const phase = process.argv[2],
    directory = process.argv[3];
process.env.PERSISTENT_DATA_DIR = directory;
process.env.LOG_LEVEL = "error";
delete process.env.REDIS_URL;
delete process.env.TMDB_API_KEY;
delete process.env.OMDB_API_KEY;
const safety = require(path.join(root, "urlSafety"));
const calls = [];
const timestamp = (time) =>
    new Date(time).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
safety.safeFetch = async (raw) => {
    if (phase === "read")
        throw new Error("Saved startup must not make upstream requests");
    const url = new URL(raw),
        action = url.searchParams.get("action");
    calls.push(action || "xmltv");
    if (url.pathname.endsWith("xmltv.php"))
        return {
            ok: true,
            body: Readable.from([
                Buffer.from(
                    '<tv><programme channel="one" start="' +
                        timestamp(Date.now() - 600000) +
                        '" stop="' +
                        timestamp(Date.now() + 3600000) +
                        '"><title>Saved programme</title><desc>Guide description</desc></programme></tv>'
                )
            ])
        };
    const values = {
        get_live_streams: [
            { stream_id: 1, name: "Live channel", epg_channel_id: "one" }
        ],
        get_vod_streams: [
            {
                stream_id: 2,
                name: "Movie (2024)",
                plot: "Provider movie description",
                container_extension: "mp4"
            }
        ],
        get_series: [
            {
                series_id: 3,
                name: "Series",
                plot: "Provider series description",
                runtime: "60 min"
            }
        ],
        get_series_info: {
            info: { runtime: "60 min" },
            episodes: {
                1: [
                    {
                        id: 4,
                        season: 1,
                        episode_num: 1,
                        title: "Episode one",
                        container_extension: "mp4"
                    }
                ]
            }
        }
    };
    return { ok: true, json: async () => values[action] || [] };
};

(async () => {
    const { checkPersistence } = require(path.join(root, "storageStatus"));
    assert.strictEqual((await checkPersistence()).directoriesChecked, 3);
    const createAddon = require(path.join(root, "addon"));
    const config = {
        provider: "xtream",
        xtreamUrl: "https://example.com",
        xtreamUsername: "dummy",
        xtreamPassword: "dummy",
        enableEpg: true
    };
    const iface = await createAddon(config);
    try {
        const movies = await iface.get("catalog", "movie", "iptv_movies", {});
        const series = await iface.get("catalog", "series", "iptv_series", {});
        assert.strictEqual(
            movies.metas[0].description,
            "Provider movie description"
        );
        assert.strictEqual(
            series.metas[0].description,
            "Provider series description"
        );
        assert.strictEqual(series.metas[0].runtime, "60 min");
        assert.strictEqual(
            calls.includes("get_series_info"),
            false,
            "catalogue/runtime work must not bulk-fetch episode lists"
        );
        if (phase === "write") {
            const details = await iface.get(
                "meta",
                "series",
                "iptv_series_3",
                {}
            );
            assert.strictEqual(details.meta.videos[0].title, "Episode one");
        }
        const episodeStream = await iface.get(
            "stream",
            "series",
            "iptv_series_ep_4",
            {}
        );
        assert.match(
            episodeStream.streams[0].url,
            /\/series\/dummy\/dummy\/4\.mp4$/
        );
        const live = await iface.get("stream", "tv", "iptv_live_1", {});
        assert.match(live.streams[0].url, /\/live\/dummy\/dummy\/1\.m3u8$/);
        const date = new Date().toISOString().slice(0, 10);
        const guide = await iface.get("catalog", "tv", "iptv_channels", {
            date
        });
        assert.strictEqual(
            guide.metasDetailed[0].videos[0].title,
            "Saved programme"
        );
        if (phase === "read") assert.deepStrictEqual(calls, []);
    } finally {
        await createAddon.disposeAddonInterface(iface);
    }
    assert.strictEqual(createAddon.getActiveInterfaceCount(), 0);
    const files = await fs.readdir(directory);
    assert(files.some((name) => name.startsWith("addon-data-")));
    assert(
        (await fs.readdir(path.join(directory, "catalog-meta"))).some((name) =>
            name.endsWith(".wal")
        )
    );
    assert(
        (await fs.readdir(path.join(directory, "series-info"))).some((name) =>
            name.endsWith(".wal")
        )
    );
    console.log(
        "FRESH_DEPLOYMENT " +
            JSON.stringify({ phase, calls, files: files.length })
    );
    process.exit(0);
})().catch((error) => {
    console.error(error.stack);
    process.exit(1);
});
