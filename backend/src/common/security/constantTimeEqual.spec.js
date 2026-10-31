"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constantTimeEqual_1 = require("./constantTimeEqual");
describe('constantTimeEqual', () => {
    it('returns true for identical strings', () => {
        expect((0, constantTimeEqual_1.constantTimeEqual)('abc', 'abc')).toBe(true);
        expect((0, constantTimeEqual_1.constantTimeEqual)('', '')).toBe(true);
        expect((0, constantTimeEqual_1.constantTimeEqual)('a-secret-token-1234567890', 'a-secret-token-1234567890')).toBe(true);
    });
    it('returns false for different content of the same length (the value compare still works)', () => {
        expect((0, constantTimeEqual_1.constantTimeEqual)('abc', 'abd')).toBe(false);
        expect((0, constantTimeEqual_1.constantTimeEqual)('secret-1', 'secret-2')).toBe(false);
    });
    it('returns false for different lengths (no early-return length leak — the digests are fixed-length)', () => {
        // The length-mismatch case must still resolve to false, just without branching on input length.
        expect((0, constantTimeEqual_1.constantTimeEqual)('a', 'ab')).toBe(false);
        expect((0, constantTimeEqual_1.constantTimeEqual)('short', 'a-much-longer-secret-value')).toBe(false);
        expect((0, constantTimeEqual_1.constantTimeEqual)('a-much-longer-secret-value', 'short')).toBe(false);
        expect((0, constantTimeEqual_1.constantTimeEqual)('', 'non-empty')).toBe(false);
        expect((0, constantTimeEqual_1.constantTimeEqual)('non-empty', '')).toBe(false);
    });
    it('handles multi-byte UTF-8 correctly (compares bytes, not chars)', () => {
        // 'é' is 2 UTF-8 bytes; 'e' is 1. Different bytes → not equal even though both "look like e".
        expect((0, constantTimeEqual_1.constantTimeEqual)('café', 'café')).toBe(true);
        expect((0, constantTimeEqual_1.constantTimeEqual)('café', 'cafe')).toBe(false);
        // Emoji are 4 bytes; equality must hold across them.
        expect((0, constantTimeEqual_1.constantTimeEqual)('🔑', '🔑')).toBe(true);
        expect((0, constantTimeEqual_1.constantTimeEqual)('🔑', '🔓')).toBe(false);
    });
    it('is reflexive and symmetric', () => {
        expect((0, constantTimeEqual_1.constantTimeEqual)('x', 'x')).toBe(true);
        expect((0, constantTimeEqual_1.constantTimeEqual)('x', 'y')).toBe(false);
        expect((0, constantTimeEqual_1.constantTimeEqual)('y', 'x')).toBe(false); // symmetric
    });
});
