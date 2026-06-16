const crypto = require('crypto');

const KEYLEN = 64;
const SALTLEN = 16;
const PREFIX = 'scrypt';

// Vrátí "scrypt$<saltHex>$<hashHex>"
function hashPassword(plain) {
    const salt = crypto.randomBytes(SALTLEN);
    const hash = crypto.scryptSync(String(plain), salt, KEYLEN);
    return PREFIX + '$' + salt.toString('hex') + '$' + hash.toString('hex');
}

// Vrátí { ok: bool, legacy: bool }.
// legacy=true znamená, že stored bylo plaintext (volající ho má upgradovat).
function verifyPassword(plain, stored) {
    if (typeof stored !== 'string') return { ok: false, legacy: false };
    if (!stored.startsWith(PREFIX + '$')) {
        // legacy plaintext porovnání
        return { ok: String(plain) === stored, legacy: true };
    }
    const parts = stored.split('$');
    if (parts.length !== 3) return { ok: false, legacy: false };
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(String(plain), salt, KEYLEN);
    const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    return { ok, legacy: false };
}

module.exports = { hashPassword, verifyPassword };
