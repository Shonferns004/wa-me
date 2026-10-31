"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const send_media_status_dto_1 = require("./send-media-status.dto");
describe('SendVoiceStatusDto validation', () => {
    const audio = { base64: 'QUJD' };
    const errorsFor = async (body) => (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(send_media_status_dto_1.SendVoiceStatusDto, body));
    it('accepts audio alone', async () => {
        expect(await errorsFor({ audio })).toHaveLength(0);
    });
    it.each([{}, { audio: {} }])('rejects a body without an audio source: %j', async (body) => {
        expect((await errorsFor(body)).some(e => e.property === 'audio')).toBe(true);
    });
    it('accepts a #RRGGBB background colour', async () => {
        expect(await errorsFor({ audio, backgroundColor: '#25D366' })).toHaveLength(0);
    });
    it.each(['green', '25D366', '#25D36', '#25D3666'])('rejects the background colour %s', async (backgroundColor) => {
        expect((await errorsFor({ audio, backgroundColor })).some(e => e.property === 'backgroundColor')).toBe(true);
    });
    it('accepts @c.us and @lid recipients', async () => {
        expect(await errorsFor({ audio, recipients: ['6281@c.us', '6281@lid'] })).toHaveLength(0);
    });
    it.each(['not-a-jid', '123@g.us', '@c.us', 'abc@lid'])('rejects the malformed JID %s', async (jid) => {
        expect((await errorsFor({ audio, recipients: [jid] })).some(e => e.property === 'recipients')).toBe(true);
    });
    it('rejects more than 256 recipients', async () => {
        const recipients = Array.from({ length: 257 }, (_, i) => `${i}@c.us`);
        expect((await errorsFor({ audio, recipients })).some(e => e.property === 'recipients')).toBe(true);
    });
});
