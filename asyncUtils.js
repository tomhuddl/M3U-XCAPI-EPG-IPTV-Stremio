"use strict";

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from(
            { length: Math.min(items.length, Math.max(1, concurrency)) },
            async () => {
                while (next < items.length) {
                    const index = next++;
                    results[index] = await mapper(items[index], index);
                }
            }
        )
    );
    return results;
}

async function withTimeout(
    operation,
    milliseconds,
    message = "Operation timed out"
) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            Object.assign(new Error(message), {
                                code: "ETIMEDOUT"
                            })
                        ),
                    milliseconds
                );
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { mapWithConcurrency, withTimeout };
