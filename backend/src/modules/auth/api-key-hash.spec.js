"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const api_key_hash_1 = require("./api-key-hash");
describe('hashApiKey', () => {
    it('uses plain SHA-256 when no pepper is set (preserves existing stored hashes)', () => {
        expect((0, api_key_hash_1.hashApiKey)('owa_secret')).toBe((0, crypto_1.createHash)('sha256').update('owa_secret').digest('hex'));
        expect((0, api_key_hash_1.hashApiKey)('owa_secret', undefined)).toBe((0, crypto_1.createHash)('sha256').update('owa_secret').digest('hex'));
    });
    it('uses HMAC-SHA256 with the pepper when set, distinct from the un-peppered hash', () => {
        const peppered = (0, api_key_hash_1.hashApiKey)('owa_secret', 'server-pepper');
        expect(peppered).toBe((0, crypto_1.createHmac)('sha256', 'server-pepper').update('owa_secret').digest('hex'));
        expect(peppered).not.toBe((0, api_key_hash_1.hashApiKey)('owa_secret'));
    });
    it('is deterministic for the same key + pepper', () => {
        expect((0, api_key_hash_1.hashApiKey)('k', 'p')).toBe((0, api_key_hash_1.hashApiKey)('k', 'p'));
    });
});
