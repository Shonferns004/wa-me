"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bearer_token_1 = require("./bearer-token");
describe('bearerToken', () => {
    it('reads the token of a Bearer header, the scheme in any case', () => {
        expect((0, bearer_token_1.bearerToken)('Bearer abc')).toBe('abc');
        expect((0, bearer_token_1.bearerToken)('bearer   abc  ')).toBe('abc');
        expect((0, bearer_token_1.bearerToken)('BEARER abc')).toBe('abc');
    });
    it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer two tokens'])('refuses %p', header => {
        expect((0, bearer_token_1.bearerToken)(header)).toBeUndefined();
    });
});
describe('presentedApiKey', () => {
    it('prefers the X-API-Key header over a Bearer token', () => {
        expect((0, bearer_token_1.presentedApiKey)({ 'x-api-key': 'from-header', authorization: 'Bearer from-bearer' })).toBe('from-header');
    });
    it('falls back to the Bearer token when the header is absent or empty', () => {
        expect((0, bearer_token_1.presentedApiKey)({ authorization: 'Bearer from-bearer' })).toBe('from-bearer');
        expect((0, bearer_token_1.presentedApiKey)({ 'x-api-key': '', authorization: 'Bearer from-bearer' })).toBe('from-bearer');
    });
    it('returns the header as it was sent, whitespace included', () => {
        expect((0, bearer_token_1.presentedApiKey)({ 'x-api-key': ' key ' })).toBe(' key ');
    });
    it('takes the first value of a repeated header', () => {
        expect((0, bearer_token_1.presentedApiKey)({ 'x-api-key': ['first', 'second'] })).toBe('first');
        expect((0, bearer_token_1.presentedApiKey)({ authorization: ['Bearer first', 'Bearer second'] })).toBe('first');
    });
    it('answers nothing when no key is presented or the Authorization header is not a Bearer one', () => {
        expect((0, bearer_token_1.presentedApiKey)({})).toBeUndefined();
        expect((0, bearer_token_1.presentedApiKey)({ authorization: 'Basic abc' })).toBeUndefined();
        expect((0, bearer_token_1.presentedApiKey)({ 'x-api-key': [] })).toBeUndefined();
    });
});
