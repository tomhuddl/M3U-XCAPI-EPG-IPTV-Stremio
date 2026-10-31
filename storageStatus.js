"use strict";
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function persistenceDirectories(env = process.env) {
    const root = env.PERSISTENT_DATA_DIR;
    return [
        ...new Set(
            [
                root,
                env.CATALOG_META_CACHE_DIR ||
                    (root && path.join(root, "catalog-meta")),
                env.SERIES_INFO_CACHE_DIR ||
                    (root && path.join(root, "series-info")),
                env.OMDB_API_KEY && (root || path.join(process.cwd(), "data"))
            ]
                .filter((value) => typeof value === "string" && value.trim())
                .map((value) => path.resolve(value))
        )
    ];
}

async function checkPersistence(env = process.env) {
    const directories = persistenceDirectories(env);
    for (const directory of directories) {
        await fs.mkdir(directory, { recursive: true });
        const probe = path.join(
            directory,
            ".storage-check-" + crypto.randomUUID()
        );
        const renamed = probe + ".renamed";
        try {
            await fs.writeFile(probe, "storage check", {
                flag: "wx",
                mode: 0o600
            });
            await fs.rename(probe, renamed);
        } finally {
            await Promise.all([
                fs.unlink(probe).catch(() => {}),
                fs.unlink(renamed).catch(() => {})
            ]);
        }
    }
    return {
        configured: Boolean(
            env.PERSISTENT_DATA_DIR ||
                env.CATALOG_META_CACHE_DIR ||
                env.SERIES_INFO_CACHE_DIR
        ),
        directoriesChecked: directories.length
    };
}

module.exports = { checkPersistence, persistenceDirectories };
