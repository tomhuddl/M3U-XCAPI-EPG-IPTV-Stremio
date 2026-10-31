"use strict";
const zlib = require("zlib");
// A small local PNG placeholder works with native players as well as browsers.
const glyphs = {
    A:[14,17,17,31,17,17,17], B:[30,17,17,30,17,17,30], C:[14,17,16,16,16,17,14],
    D:[30,17,17,17,17,17,30], E:[31,16,16,30,16,16,31], F:[31,16,16,30,16,16,16],
    G:[14,17,16,23,17,17,15], H:[17,17,17,31,17,17,17], I:[14,4,4,4,4,4,14],
    J:[7,2,2,2,2,18,12], K:[17,18,20,24,20,18,17], L:[16,16,16,16,16,16,31],
    M:[17,27,21,21,17,17,17], N:[17,25,21,19,17,17,17], O:[14,17,17,17,17,17,14],
    P:[30,17,17,30,16,16,16], Q:[14,17,17,17,21,18,13], R:[30,17,17,30,20,18,17],
    S:[15,16,16,14,1,1,30], T:[31,4,4,4,4,4,4], U:[17,17,17,17,17,17,14],
    V:[17,17,17,17,17,10,4], W:[17,17,17,21,21,21,10], X:[17,17,10,4,10,17,17],
    Y:[17,17,10,4,4,4,4], Z:[31,1,2,4,8,16,31],
    0:[14,17,19,21,25,17,14], 1:[4,12,4,4,4,4,14], 2:[14,17,1,2,4,8,31],
    3:[30,1,1,14,1,1,30], 4:[2,6,10,18,31,2,2], 5:[31,16,16,30,1,1,30],
    6:[14,16,16,30,17,17,14], 7:[31,1,2,4,8,8,8], 8:[14,17,17,14,17,17,14], 9:[14,17,17,15,1,1,14],
    " ":[0,0,0,0,0,0,0], "-":[0,0,0,31,0,0,0], ".":[0,0,0,0,0,12,12],
    "+":[0,4,4,31,4,4,0], "?":[14,17,1,2,4,0,4]
};
function chunk(name, data) {
    const type = Buffer.from(name), value = Buffer.concat([type, data]);
    let crc = 0xffffffff;
    for (const byte of value) {
        crc ^= byte;
        for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, type, data, checksum]);
}
const cache = new Map();
module.exports = function fallbackLogo(label) {
    const text = String(label || "Live TV").normalize("NFKD").replace(/\p{M}/gu, "")
        .replace(/\.[a-z]{2,3}$/i, "").toUpperCase().slice(0, 12);
    if (cache.has(text)) return cache.get(text);
    const width = 300, height = 400, stride = width * 4 + 1;
    const pixels = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = y * stride + 1 + x * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 51; pixels[at + 3] = 255;
    }
    const left = Math.floor((width - text.length * 18 + 3) / 2);
    for (let i = 0; i < text.length; i++) {
        const glyph = glyphs[text[i]] || glyphs["?"];
        for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (glyph[y] & (1 << (4 - x)))
            for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
                const at = (189 + y * 3 + dy) * stride + 1 + (left + i * 18 + x * 3 + dx) * 4;
                pixels[at] = pixels[at + 1] = pixels[at + 2] = 255;
            }
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
    header[8] = 8; header[9] = 6;
    const result = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
        chunk("IDAT", zlib.deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
    cache.set(text, result); if (cache.size > 100) cache.delete(cache.keys().next().value);
    return result;
};
