"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const wwebjs_messaging_1 = require("./wwebjs-messaging");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * whatsapp-web.js returns null from sendMessage, without touching the page, for some content shapes
 * on a channel or a status/broadcast recipient (Client.js sendMessage). Read as a result, that null
 * is a 500 saying the message may have gone out, which the send breaker counts. These pin the 501
 * the adapter answers instead, before the library is called at all. It is a plain 501 rather than
 * EngineNotSupportedError: the methods are supported, only these recipients are refused, and that
 * class marks a whole method unavailable in the capability matrix.
 */
const logger = (0, logger_service_1.createLogger)('wwebjs-send-shape-refusal.spec');
function makeMessaging() {
    const client = {
        sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1 }),
    };
    const host = {
        ensureReady: jest.fn(),
        ensureNotChannelRecipient: jest.fn(),
        getClient: () => client,
        logger,
        config: {},
        getNumberId: jest.fn(),
        reportIfPageTransportError: jest.fn(),
    };
    return { messaging: new wwebjs_messaging_1.WwebjsMessaging(host), client };
}
const IMAGE = {
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    mimetype: 'image/png',
};
const QUOTED = 'true_628111@c.us_3EB0ABCD';
const CHANNEL = '120363000000000000@newsletter';
const STATUS = 'status@broadcast';
const LIST = '1700000000@broadcast';
const location = (m, to) => m.sendLocationMessage(to, { latitude: 1, longitude: 2 });
const contact = (m, to) => m.sendContactMessage(to, { name: 'Alice', number: '628999' });
const poll = (m, to) => m.sendPollMessage(to, { name: 'Q', options: ['a', 'b'] });
const sticker = (m, to) => m.sendStickerMessage(to, IMAGE);
const quotedText = (m, to) => m.sendTextMessage(to, 'hi', undefined, { quotedMessageId: QUOTED });
const quotedImage = (m, to) => m.sendImageMessage(to, { ...IMAGE, quotedMessageId: QUOTED });
describe('WwebjsMessaging: a send whatsapp-web.js drops for the recipient', () => {
    it.each([
        ['location', CHANNEL, location],
        ['contact card', CHANNEL, contact],
        ['quoted text', CHANNEL, quotedText],
        ['quoted image', CHANNEL, quotedImage],
        ['location', STATUS, location],
        ['contact card', STATUS, contact],
        ['poll', STATUS, poll],
        ['sticker', STATUS, sticker],
        ['quoted text', STATUS, quotedText],
        ['location', LIST, location],
        ['contact card', LIST, contact],
        ['poll', LIST, poll],
        ['sticker', LIST, sticker],
        ['quoted image', LIST, quotedImage],
    ])('refuses a %s to %s with a 501 and never calls the library', async (_shape, to, send) => {
        const { messaging, client } = makeMessaging();
        const err = (await send(messaging, to).catch((e) => e));
        expect(err).toBeInstanceOf(common_1.NotImplementedException);
        expect(err.getStatus()).toBe(501);
        expect(err.message).toContain('nothing was sent');
        expect(client.sendMessage).not.toHaveBeenCalled();
    });
    it('refuses a reply to a channel before looking the quoted message up', async () => {
        const { messaging, client } = makeMessaging();
        const getChatById = jest.fn();
        Object.assign(client, { getChatById });
        await expect(messaging.replyToMessage(CHANNEL, QUOTED, 'hi')).rejects.toBeInstanceOf(common_1.NotImplementedException);
        expect(getChatById).not.toHaveBeenCalled();
    });
    // Known-negative control: the shapes the library does send there must still reach it, or the guard
    // would be refusing working sends.
    it.each([
        ['poll', CHANNEL, poll],
        ['plain text', STATUS, (m, to) => m.sendTextMessage(to, 'hi')],
        ['plain image', LIST, (m, to) => m.sendImageMessage(to, IMAGE)],
        ['location', '628111@c.us', location],
        ['quoted text', '120363000000000000@g.us', quotedText],
    ])('still sends a %s to %s', async (_shape, to, send) => {
        const { messaging, client } = makeMessaging();
        await send(messaging, to);
        expect(client.sendMessage).toHaveBeenCalledTimes(1);
    });
});
