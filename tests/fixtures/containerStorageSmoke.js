"use strict";
const assert = require("assert"),
    path = require("path");
const app = process.cwd();
if (typeof process.getuid === "function")
    assert.notStrictEqual(
        process.getuid(),
        0,
        "production image must run as a non-root user"
    );
const Provider = require(path.join(app, "persistentAddonDataCache"));
const Catalog = require(path.join(app, "persistentCatalogMetaCache"));
const Series = require(path.join(app, "persistentSeriesInfoCache"));
const key = "0".repeat(64),
    provider = new Provider(key),
    catalog = new Catalog(key),
    series = new Series(key);
(async () => {
    await require(path.join(app, "storageStatus")).checkPersistence();
    if (process.argv[2] === "write") {
        await provider.save({
            channels: [{ id: "iptv_live_1", name: "Live" }],
            movies: [],
            series: [],
            epgData: {},
            lastUpdate: 1
        });
        await catalog.set("iptv_vod_2", {
            id: "iptv_vod_2",
            type: "movie",
            name: "Saved movie",
            description: "Saved description"
        });
        await series.set(
            "3",
            {
                videos: [
                    {
                        id: "iptv_series_ep_4",
                        season: 1,
                        episode: 1,
                        url: "https://example.com/episode.mp4"
                    }
                ]
            },
            1
        );
        await Promise.all([provider.flush(), catalog.flush(), series.flush()]);
    } else {
        assert.strictEqual((await provider.load()).channels[0].name, "Live");
        assert.strictEqual(
            (await catalog.get("iptv_vod_2")).value.description,
            "Saved description"
        );
        assert.strictEqual(
            (await series.get("3", 1)).value.videos[0].id,
            "iptv_series_ep_4"
        );
    }
    console.log("Container persistence check passed:", process.argv[2]);
})().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
});
