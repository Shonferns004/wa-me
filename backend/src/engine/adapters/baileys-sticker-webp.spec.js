"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const sharp_1 = __importDefault(require("sharp"));
const baileys_messaging_1 = require("./baileys-messaging");
const logger_service_1 = require("../../common/services/logger.service");
const engine_not_sent_error_1 = require("../../common/errors/engine-not-sent.error");
/**
 * Baileys stamps the sticker mimetype unconditionally: `prepareWAMessageMedia` applies
 * `if (!uploadData.mimetype) uploadData.mimetype = MIMETYPE_MAP[mediaType]` with
 * `MIMETYPE_MAP.sticker = 'image/webp'` (Utils/messages.js:18, 86-88), and nothing on that path
 * transcodes. So whatever bytes the adapter hands over are published AS WebP whether they are WebP
 * or not — a PNG goes out labelled `image/webp` with PNG bytes, and the send reports success.
 *
 * whatsapp-web.js does not have this problem: `sendMediaAsSticker: true` routes through
 * `Util.formatToWebpSticker` (Client.js:1532, Util.js:152-159), which converts `image/*` and
 * throws `Invalid media format` for anything else.
 *
 * These assertions are about what reaches the socket, because that is where the two engines
 * diverged. The label is not ours to check — Baileys writes it — so the only thing that can keep
 * label and payload honest is the payload.
 */
const logger = (0, logger_service_1.createLogger)('baileys-sticker-webp.spec');
// 1x1 PNG and the same pixel encoded as a real WebP. Fixtures rather than a sharp call at test
// time, so a failure means the adapter changed rather than the encoder did.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.from('UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAf1ZQOCAwAAAA0AEAnQEqAQABAAFAJiWgAnS6AfgAA7AA/vLrf/zYFc1z7/f/0uD9Lg/S4P/SkAAA', 'base64');
// A hand-built 2-frame GIF89a (red, then blue), used to prove animation survives the conversion.
const ANIMATED_GIF = Buffer.from('R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==', 'base64');
/** A GIF89a of `frames` 1x1 frames: about 23 bytes each, so a large count stays a small upload. */
function manyFrameGif(frames) {
    const head = Buffer.concat([
        Buffer.from('GIF89a'),
        Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x21, 0xff, 0x0b]),
        Buffer.from('NETSCAPE2.0'),
        Buffer.from([3, 1, 0, 0, 0]),
    ]);
    const frame = Buffer.from([0x21, 0xf9, 4, 0, 1, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0]);
    return Buffer.concat([head, ...Array(frames).fill(frame), Buffer.from([0x3b])]);
}
const isWebp = (b) => Buffer.isBuffer(b) &&
    b.length > 12 &&
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP';
function makeMessaging() {
    const sock = {
        onWhatsApp: jest.fn((jid) => Promise.resolve([{ jid, exists: true }])),
        sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
    };
    const host = {
        ensureReady: jest.fn(),
        sessionProxyUrl: () => undefined,
        getSocket: () => sock,
        getSocketOrNull: () => sock,
        logger,
        toNeutralJid: (j) => j,
        toEngineJid: (j) => j,
        normalizedSelfJid: () => '628177@s.whatsapp.net',
        getEphemeralExpiration: () => undefined,
        toUnixSeconds: () => 1,
        loadLib: () => Promise.resolve({}),
        getStoredMessage: () => Promise.resolve(undefined),
        wasDeletedForEveryone: () => false,
        pendingEditOf: () => undefined,
        markDeletedForEveryone: () => undefined,
        putStoredMessage: () => undefined,
        recordMessage: () => undefined,
        rememberOwnSend: () => undefined,
        recordLidMapping: () => undefined,
        getOnMessageCreate: () => undefined,
        mapMessage: () => Promise.resolve({}),
    };
    return { messaging: new baileys_messaging_1.BaileysMessaging(host), sock };
}
const contentOf = (sock) => {
    const [, content] = sock.sendMessage.mock.calls[0];
    return content;
};
describe('BaileysMessaging.sendStickerMessage — what reaches the socket must really be WebP', () => {
    it('a PNG sticker never puts non-WebP bytes on the wire', async () => {
        const { messaging, sock } = makeMessaging();
        await messaging.sendStickerMessage('628111@s.whatsapp.net', { data: PNG, mimetype: 'image/png' });
        expect(sock.sendMessage).toHaveBeenCalledTimes(1);
        expect(isWebp(contentOf(sock).sticker)).toBe(true);
    });
    // Known-negative control. Without it a converter that mangled every input would still pass the
    // assertion above, and the oracle would be measuring nothing.
    it('a genuine WebP sticker still goes out byte-identical', async () => {
        const { messaging, sock } = makeMessaging();
        await messaging.sendStickerMessage('628111@s.whatsapp.net', { data: WEBP, mimetype: 'image/webp' });
        const sent = contentOf(sock).sticker;
        expect(isWebp(sent)).toBe(true);
        // Re-encoding an existing sticker would strip the WebP EXIF sticker-pack metadata and change
        // its size, so passthrough is a requirement rather than an optimisation.
        expect(sent.equals(WEBP)).toBe(true);
    });
    // The placeholder the DTO applies when a caller supplies no mimetype. A converter that trusted
    // the label would treat this as "not an image" and refuse a perfectly good sticker.
    it('a genuine WebP labelled application/octet-stream is recognised by its bytes', async () => {
        const { messaging, sock } = makeMessaging();
        await messaging.sendStickerMessage('628111@s.whatsapp.net', {
            data: WEBP,
            mimetype: 'application/octet-stream',
        });
        expect(contentOf(sock).sticker.equals(WEBP)).toBe(true);
    });
    // A converter that drops `{ animated: true }` keeps only the first frame and still emits valid
    // WebP, so every other assertion here would stay green while animated stickers silently became
    // stills — the same shape of quiet corruption this whole change is about.
    it('an animated source keeps its frames', async () => {
        const { messaging, sock } = makeMessaging();
        await messaging.sendStickerMessage('628111@s.whatsapp.net', { data: ANIMATED_GIF, mimetype: 'image/gif' });
        const sent = contentOf(sock).sticker;
        expect(isWebp(sent)).toBe(true);
        expect((await (0, sharp_1.default)(sent, { animated: true }).metadata()).pages).toBe(2);
    });
    // Conversion cost is linear in the frame count, and 1x1 frames make that count nearly free to
    // inflate: 25,000 of them fit in under 600 KB and keep a threadpool worker busy for tens of seconds.
    it('an animation with too many frames is refused as a 400 without being converted', async () => {
        const { messaging, sock } = makeMessaging();
        const convert = jest.spyOn(sharp_1.default.prototype, 'toBuffer');
        try {
            const send = messaging.sendStickerMessage('628111@s.whatsapp.net', {
                data: manyFrameGif(baileys_messaging_1.MAX_STICKER_FRAMES + 1),
                mimetype: 'image/gif',
            });
            await expect(send).rejects.toBeInstanceOf(common_1.BadRequestException);
            await expect(send).rejects.toThrow(`has ${baileys_messaging_1.MAX_STICKER_FRAMES + 1} frames; at most ${baileys_messaging_1.MAX_STICKER_FRAMES}`);
            expect(convert).not.toHaveBeenCalled();
            expect(sock.sendMessage).not.toHaveBeenCalled();
            // Refused before anything reached WhatsApp, so a keyed send frees its Idempotency-Key.
            expect((0, engine_not_sent_error_1.provesNothingSent)(await send.catch((error) => error))).toBe(true);
        }
        finally {
            convert.mockRestore();
        }
    });
    // Each pipeline holds a libuv worker for its whole run; unbounded, a handful of concurrent
    // conversions occupy the pool that fs, dns.lookup and crypto also wait on. The frame scan is
    // threadpool work too, and on a GIF of tens of MB it takes seconds, so it waits for a slot as well.
    it('runs at most two conversions at once, frame scan included, and queues the rest', async () => {
        const pending = [];
        const metadata = jest.spyOn(sharp_1.default.prototype, 'metadata').mockResolvedValue({ pages: 1 });
        const convert = jest
            .spyOn(sharp_1.default.prototype, 'toBuffer')
            .mockImplementation(() => new Promise(resolve => pending.push(resolve)));
        const settle = () => new Promise(resolve => setImmediate(resolve));
        try {
            const { messaging, sock } = makeMessaging();
            const sends = [1, 2, 3].map(() => messaging.sendStickerMessage('628111@s.whatsapp.net', { data: PNG, mimetype: 'image/png' }));
            await settle();
            expect(metadata).toHaveBeenCalledTimes(2);
            expect(convert).toHaveBeenCalledTimes(2);
            pending.shift()(WEBP);
            await settle();
            expect(metadata).toHaveBeenCalledTimes(3);
            expect(convert).toHaveBeenCalledTimes(3);
            pending.splice(0).forEach(resolve => resolve(WEBP));
            await Promise.all(sends);
            expect(sock.sendMessage).toHaveBeenCalledTimes(3);
        }
        finally {
            metadata.mockRestore();
            convert.mockRestore();
        }
    });
    it('input that cannot become a sticker is refused BEFORE the socket, as a 400', async () => {
        const { messaging, sock } = makeMessaging();
        const send = messaging.sendStickerMessage('628111@s.whatsapp.net', {
            data: Buffer.from('%PDF-1.4 this is not an image'),
            mimetype: 'application/pdf',
        });
        await expect(send).rejects.toBeInstanceOf(common_1.BadRequestException);
        // Rejected on the DECLARED type, before the bytes reach the image decoder — the message names
        // what was received. Without that check a PDF still ends in a 400, but only after libvips has
        // been handed arbitrary bytes to parse, and this assertion is what keeps the two apart.
        await expect(send).rejects.toThrow(/Received 'application\/pdf'/);
        // Shipping it mislabelled is the defect; refusing after the send would not fix it.
        expect(sock.sendMessage).not.toHaveBeenCalled();
    });
});
describe('blockSvgDecoding', () => {
    const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
    // The block is libvips process state: start from the default and leave it as found, so no other
    // spec in the same worker sees it.
    const reset = () => sharp_1.default.unblock({ operation: ['VipsForeignLoadSvg'] });
    beforeEach(reset);
    afterAll(reset);
    it('refuses SVG input, which a sticker or an outbound image thumbnail would hand to librsvg, and still decodes a raster', async () => {
        await expect((0, sharp_1.default)(SVG).metadata()).resolves.toMatchObject({ format: 'svg' });
        await (0, baileys_messaging_1.blockSvgDecoding)();
        await expect((0, sharp_1.default)(SVG).metadata()).rejects.toThrow();
        await expect((0, sharp_1.default)(PNG).metadata()).resolves.toMatchObject({ format: 'png' });
    });
});
