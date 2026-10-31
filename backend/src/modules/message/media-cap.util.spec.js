"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const media_cap_util_1 = require("./media-cap.util");
describe('assertBase64WithinMediaCap', () => {
    const orig = process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    afterEach(() => {
        if (orig === undefined)
            delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
        else
            process.env.MEDIA_DOWNLOAD_MAX_BYTES = orig;
    });
    /** A base64 string that decodes to exactly `bytes` bytes. */
    const base64OfBytes = (bytes) => Buffer.alloc(bytes).toString('base64');
    it('does nothing for an empty or missing value', () => {
        expect(() => (0, media_cap_util_1.assertBase64WithinMediaCap)(undefined)).not.toThrow();
        expect(() => (0, media_cap_util_1.assertBase64WithinMediaCap)(null)).not.toThrow();
        expect(() => (0, media_cap_util_1.assertBase64WithinMediaCap)('')).not.toThrow();
    });
    it('strips only a data-URI base64 prefix and preserves plain base64', () => {
        expect((0, media_cap_util_1.stripBase64DataUri)('data:image/png;base64,QUJD')).toBe('QUJD');
        expect((0, media_cap_util_1.stripBase64DataUri)('QUJD')).toBe('QUJD');
    });
    it('accepts a base64 payload at the cap', () => {
        process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1024';
        expect(() => (0, media_cap_util_1.assertBase64WithinMediaCap)(base64OfBytes(1024))).not.toThrow();
    });
    it('rejects a base64 payload over the cap with a 413', () => {
        process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1024';
        expect(() => (0, media_cap_util_1.assertBase64WithinMediaCap)(base64OfBytes(1025))).toThrow(common_1.PayloadTooLargeException);
    });
    it('honors the MEDIA_DOWNLOAD_MAX_BYTES override (shared with the URL/inbound caps)', () => {
        process.env.MEDIA_DOWNLOAD_MAX_BYTES = '2048';
        expect(() => (0, media_cap_util_1.assertBase64WithinMediaCap)(base64OfBytes(2000))).not.toThrow();
        expect(() => (0, media_cap_util_1.assertBase64WithinMediaCap)(base64OfBytes(4096))).toThrow(common_1.PayloadTooLargeException);
    });
});
describe('resolveMediaBody', () => {
    const orig = process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    afterEach(() => {
        if (orig === undefined)
            delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
        else
            process.env.MEDIA_DOWNLOAD_MAX_BYTES = orig;
    });
    const FALLBACK = { fallbackMimetype: 'image/jpeg' };
    it('refuses a body with neither a url nor base64', () => {
        expect(() => (0, media_cap_util_1.resolveMediaBody)({}, FALLBACK)).toThrow('Either url or base64 must be provided');
        expect(() => (0, media_cap_util_1.resolveMediaBody)(undefined, FALLBACK)).toThrow(common_1.BadRequestException);
        // A data-URI prefix with nothing after it holds no data.
        expect(() => (0, media_cap_util_1.resolveMediaBody)({ base64: 'data:image/png;base64,' }, FALLBACK)).toThrow(common_1.BadRequestException);
    });
    it('uses the url when only a url is given, typed by the fallback unless the body names a type', () => {
        expect((0, media_cap_util_1.resolveMediaBody)({ url: 'https://cdn.example/a.jpg' }, FALLBACK)).toEqual({
            mimetype: 'image/jpeg',
            data: 'https://cdn.example/a.jpg',
        });
        expect((0, media_cap_util_1.resolveMediaBody)({ url: 'https://cdn.example/a.png', mimetype: 'image/png' }, FALLBACK).mimetype).toBe('image/png');
    });
    it('lets base64 win over a stale url, and strips a data-URI prefix', () => {
        expect((0, media_cap_util_1.resolveMediaBody)({ url: 'https://stale.example/x', base64: 'data:image/png;base64,QUJD', mimetype: 'image/png' }, FALLBACK)).toEqual({ mimetype: 'image/png', data: 'QUJD' });
    });
    it('requires a type for base64 only when asked to', () => {
        expect(() => (0, media_cap_util_1.resolveMediaBody)({ base64: 'QUJD' }, { ...FALLBACK, requireMimetypeForBase64: true })).toThrow('mimetype is required when using base64 data');
        expect((0, media_cap_util_1.resolveMediaBody)({ base64: 'QUJD' }, FALLBACK)).toEqual({ mimetype: 'image/jpeg', data: 'QUJD' });
        // A url needs no declared type: it is typed by what it answers with.
        expect(() => (0, media_cap_util_1.resolveMediaBody)({ url: 'https://cdn.example/a' }, { ...FALLBACK, requireMimetypeForBase64: true })).not.toThrow();
    });
    it('checks the shape of the url only when asked to, and not when base64 holds the data', () => {
        expect(() => (0, media_cap_util_1.resolveMediaBody)({ url: 'cdn.example/a.jpg' }, { ...FALLBACK, checkUrl: true })).toThrow('url must be an absolute http(s) URL');
        expect(() => (0, media_cap_util_1.resolveMediaBody)({ url: 'cdn.example/a.jpg' }, FALLBACK)).not.toThrow();
        expect(() => (0, media_cap_util_1.resolveMediaBody)({ url: 'junk', base64: 'QUJD', mimetype: 'image/png' }, { ...FALLBACK, checkUrl: true })).not.toThrow();
    });
    it('refuses base64 over the media cap with a 413, after the other checks', () => {
        process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1024';
        const big = Buffer.alloc(2048).toString('base64');
        expect(() => (0, media_cap_util_1.resolveMediaBody)({ base64: big, mimetype: 'image/png' }, FALLBACK)).toThrow(common_1.PayloadTooLargeException);
        // The type check comes first, so a body that breaks both reports the type.
        expect(() => (0, media_cap_util_1.resolveMediaBody)({ base64: big }, { ...FALLBACK, requireMimetypeForBase64: true })).toThrow('mimetype is required');
    });
});
