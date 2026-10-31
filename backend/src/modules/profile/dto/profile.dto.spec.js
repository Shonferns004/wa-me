"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const profile_dto_1 = require("./profile.dto");
// Mirror the global ValidationPipe options (src/main.ts): whitelist + forbidNonWhitelisted.
const PIPE_OPTS = { whitelist: true, forbidNonWhitelisted: true };
function errorsFor(cls, payload) {
    return (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(cls, payload), PIPE_OPTS);
}
describe('profile DTO validation', () => {
    it('requires a non-empty name within the WhatsApp limit (25)', async () => {
        expect(await errorsFor(profile_dto_1.SetProfileNameDto, { name: 'OpenWA Bot' })).toHaveLength(0);
        expect((await errorsFor(profile_dto_1.SetProfileNameDto, { name: '' })).length).toBeGreaterThan(0);
        expect((await errorsFor(profile_dto_1.SetProfileNameDto, {})).length).toBeGreaterThan(0);
        expect((await errorsFor(profile_dto_1.SetProfileNameDto, { name: 'x'.repeat(26) })).length).toBeGreaterThan(0);
    });
    it('allows an empty status (clears the about) and caps it at the WhatsApp limit (139)', async () => {
        expect(await errorsFor(profile_dto_1.SetProfileStatusDto, { status: '' })).toHaveLength(0);
        expect(await errorsFor(profile_dto_1.SetProfileStatusDto, { status: 'x'.repeat(139) })).toHaveLength(0);
        expect((await errorsFor(profile_dto_1.SetProfileStatusDto, { status: 'x'.repeat(140) })).length).toBeGreaterThan(0);
        expect((await errorsFor(profile_dto_1.SetProfileStatusDto, {})).length).toBeGreaterThan(0);
    });
    it('accepts a picture body with url or base64 (either/or is a service rule)', async () => {
        expect(await errorsFor(profile_dto_1.SetProfilePictureDto, { url: 'https://example.com/a.jpg' })).toHaveLength(0);
        expect(await errorsFor(profile_dto_1.SetProfilePictureDto, { base64: 'QUJD', mimetype: 'image/png' })).toHaveLength(0);
    });
    it('rejects a non-URL url and skips the URL check when base64 is present (#670 alignment)', async () => {
        expect((await errorsFor(profile_dto_1.SetProfilePictureDto, { url: 'not-a-url' })).length).toBeGreaterThan(0);
        expect(await errorsFor(profile_dto_1.SetProfilePictureDto, { url: 'not-a-url', base64: 'QUJD' })).toHaveLength(0);
    });
    it('rejects a non-string base64 even when a url is also sent', async () => {
        for (const url of ['https://example.com/a.jpg', 'not-a-url']) {
            const body = { url, base64: ['x'], mimetype: 'image/png' };
            expect((await errorsFor(profile_dto_1.SetProfilePictureDto, body)).length).toBeGreaterThan(0);
        }
    });
    it('accepts only an absolute http(s) url, the only form the engines fetch', async () => {
        for (const url of ['example.com/a.jpg', 'ftp://example.com/a.jpg']) {
            expect((await errorsFor(profile_dto_1.SetProfilePictureDto, { url })).length).toBeGreaterThan(0);
        }
        for (const url of ['https://example.com/a.jpg', 'HTTPS://example.com/a.jpg', 'http://example.com/a.jpg']) {
            expect(await errorsFor(profile_dto_1.SetProfilePictureDto, { url })).toHaveLength(0);
        }
        expect(await errorsFor(profile_dto_1.SetProfilePictureDto, { url: 'example.com/a.jpg', base64: 'QUJD' })).toHaveLength(0);
        // A base64 that is only a data-URI prefix strips to nothing, so the url is what would be sent.
        const prefixOnly = { url: 'cdn/avatar.jpg', base64: 'data:image/jpeg;base64,', mimetype: 'image/jpeg' };
        expect((await errorsFor(profile_dto_1.SetProfilePictureDto, prefixOnly)).length).toBeGreaterThan(0);
    });
    it('rejects a non-image mimetype fast (400) — a profile picture is an image by definition', async () => {
        expect((await errorsFor(profile_dto_1.SetProfilePictureDto, { base64: 'QUJD', mimetype: 'application/pdf' })).length).toBeGreaterThan(0);
        expect(await errorsFor(profile_dto_1.SetProfilePictureDto, { base64: 'QUJD', mimetype: 'image/png' })).toHaveLength(0);
    });
    it('still rejects unknown properties (forbidNonWhitelisted intact)', async () => {
        const errors = await errorsFor(profile_dto_1.SetProfilePictureDto, { base64: 'QUJD', hacker: true });
        expect(errors.some(e => e.property === 'hacker')).toBe(true);
    });
});
