"use strict";
const zlib = require("zlib");
let activeCompressions = 0;
function encodingFor(header) {
    const values = String(header || "").toLowerCase().split(",").map(value => {
        const [name, ...params] = value.trim().split(";");
        const q = params.find(p => p.trim().startsWith("q="));
        return { name, q: q ? Number(q.trim().slice(2)) : 1 };
    }).filter(value => Number.isFinite(value.q) && value.q > 0);
    return ["br", "gzip"].map(name => ({ name, q: values.find(v => v.name === name)?.q || 0 }))
        .sort((a, b) => b.q - a.q).find(v => v.q > 0)?.name;
}
module.exports = function responseCompression(req, res, next) {
    const originalEnd = res.end.bind(res);
    res.end = function (chunk, encoding, callback) {
        if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
        const kind = encodingFor(req.headers["accept-encoding"]);
        const eligible = req.method !== "HEAD" && ![204, 304].includes(res.statusCode) &&
            chunk != null && !res.headersSent && !res.getHeader("Content-Encoding") &&
            String(res.getHeader("Content-Type") || "").includes("application/json");
        if (!eligible) return originalEnd(chunk, encoding, callback);
        const vary = String(res.getHeader("Vary") || "").split(",").map(value => value.trim()).filter(Boolean);
        if (!vary.some(value => value.toLowerCase() === "accept-encoding" || value === "*")) vary.push("Accept-Encoding");
        res.setHeader("Vary", vary.join(", "));
        if (!kind || activeCompressions >= 2) return originalEnd(chunk, encoding, callback);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || "utf8");
        if (buffer.length < 1024) return originalEnd(chunk, encoding, callback);
        activeCompressions++;
        const done = (error, compressed) => {
            activeCompressions--;
            if (res.destroyed) return;
            if (error || compressed.length >= buffer.length) return originalEnd(chunk, encoding, callback);
            res.removeHeader("Content-Length"); res.setHeader("Content-Encoding", kind);
            return originalEnd(compressed, undefined, callback);
        };
        if (kind === "br") zlib.brotliCompress(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, done);
        else zlib.gzip(buffer, { level: 4 }, done);
        return res;
    };
    next();
};
