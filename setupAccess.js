"use strict";
const crypto = require("crypto");

function equal(value, expected) {
    const a = crypto.createHash("sha256").update(value).digest();
    const b = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

module.exports = function setupAccess(req, res, next) {
    const password = process.env.SETUP_PASSWORD;
    if (!password) return next();
    const protectedRoute =
        /^\/(?:$|index\.html$|configure-(?:direct|xtream)$|html\/(?:direct|xtream)-config\.html$|encrypt$|api\/)/.test(
            req.path
        );
    if (!protectedRoute) return next();
    if (password.length < 16)
        return res
            .status(503)
            .json({
                error: "SETUP_PASSWORD must contain at least 16 characters"
            });
    const header = String(req.headers.authorization || "");
    let user = "",
        supplied = "";
    if (/^Basic [A-Za-z0-9+/]+=*$/i.test(header)) {
        const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        if (colon >= 0) {
            user = decoded.slice(0, colon);
            supplied = decoded.slice(colon + 1);
        }
    }
    if (
        equal(user, process.env.SETUP_USERNAME || "admin") &&
        equal(supplied, password)
    )
        return next();
    res.setHeader(
        "WWW-Authenticate",
        'Basic realm="Addon setup", charset="UTF-8"'
    );
    res.setHeader("Cache-Control", "no-store");
    return res
        .status(401)
        .json({ error: "Owner access is required to configure this addon" });
};
