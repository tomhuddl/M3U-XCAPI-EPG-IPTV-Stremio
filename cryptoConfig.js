require('dotenv').config();
const crypto = require('crypto');

/**
 * Derive a 32-byte key from CONFIG_SECRET (if present & sufficiently long).
 */
function getSecret() {
    const secret = process.env.CONFIG_SECRET;
    if (!secret || secret.length < 16) return null;
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt JSON string with AES-256-GCM (iv(12) + tag(16) + ciphertext) -> base64 prefixed with enc:
 */
function encryptConfig(jsonStr) {
    const key = getSecret();
    if (!key) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, ciphertext]);
    return 'enc:' + payload.toString('base64url');
}

/**
 * Decrypt enc:<base64> token
 */
function decryptConfig(token) {
    if (!token.startsWith('enc:')) throw new Error('Not encrypted');
    const key = getSecret();
    if (!key) throw new Error('Encryption disabled');
    const b64 = token.slice(4);
    if (
        b64.length > 1024 * 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(b64) ||
        b64.length % 4 === 1
    ) throw new Error('Bad payload');
    const buf = Buffer.from(b64, 'base64url');
    if (buf.toString('base64url') !== b64 || buf.length < 12 + 16 + 1) {
        throw new Error('Bad payload');
    }
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

/**
 * Decode plain (possibly base64url) token and parse JSON.
 * Accepts:
 *  - enc:<base64> encrypted
 *  - base64 (with + / =)
 *  - base64url ( - _ no padding)
 */
function tryParseConfigToken(token) {
    if (typeof token !== 'string' || !token) throw new Error('Empty token');
    if (token.length > 1024 * 1024) throw new Error('Configuration token too large');
    if (token.startsWith('enc:')) return decryptConfig(token);

    // Legacy Base64 tokens expose their configuration in plaintext and can be
    // forged without CONFIG_SECRET. Require an explicit opt-in for migration.
    if ((process.env.ALLOW_LEGACY_CONFIG_TOKENS || "").toLowerCase() !== "true") {
        throw new Error("Legacy unencrypted configuration tokens are disabled");
    }
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(token) ||
        (/[+/]/.test(token) && /[-_]/.test(token))) {
        throw new Error('Invalid base64');
    }

    // Normalize base64url -> base64
    let base = token.replace(/-/g, '+').replace(/_/g, '/');
    // Re-pad
    const padNeeded = (4 - (base.length % 4)) % 4;
    if (padNeeded) base += '='.repeat(padNeeded);

    let jsonStr;
    try {
        const raw = Buffer.from(base, 'base64').toString('utf8');
        jsonStr = raw;
    } catch {
        throw new Error('Invalid base64');
    }
    try {
        return JSON.parse(jsonStr);
    } catch {
        throw new Error('Invalid JSON config');
    }
}

module.exports = {
    encryptConfig,
    decryptConfig,
    tryParseConfigToken
};