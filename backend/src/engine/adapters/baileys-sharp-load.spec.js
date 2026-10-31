"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
// Force the deferred `sharp` binary to fail to load, the way an older CPU or a stripped/musl image
// does at runtime. The dynamic import inside loadSharp then rejects.
jest.mock('sharp', () => {
    throw new Error('ERR_DLOPEN_FAILED: sharp native binary could not be loaded');
});
const baileys_messaging_1 = require("./baileys-messaging");
const logger_service_1 = require("../../common/services/logger.service");
describe('loadSharp', () => {
    it('maps a sharp native-load failure to a 500, not the decode path 400', async () => {
        // A valid PNG would hit this same path, so a 400 would wrongly blame the caller's image.
        await expect((0, baileys_messaging_1.loadSharp)()).rejects.toBeInstanceOf(common_1.InternalServerErrorException);
    });
});
describe('a link preview image without sharp', () => {
    it('is uploaded as the caller sent it, since nothing can re-encode it', async () => {
        const sock = {
            waUploadToServer: jest.fn(),
            onWhatsApp: jest.fn((jid) => Promise.resolve([{ jid, exists: true }])),
            sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
        };
        const prepareWAMessageMedia = jest.fn().mockResolvedValue({ imageMessage: { directPath: '/d' } });
        const host = {
            ensureReady: jest.fn(),
            sessionProxyUrl: () => undefined,
            getSocket: () => sock,
            getSocketOrNull: () => sock,
            logger: (0, logger_service_1.createLogger)('baileys-sharp-load.spec'),
            toNeutralJid: (j) => j,
            toEngineJid: (j) => j,
            normalizedSelfJid: () => '628177@s.whatsapp.net',
            getEphemeralExpiration: () => undefined,
            toUnixSeconds: () => 1,
            loadLib: () => Promise.resolve({ prepareWAMessageMedia }),
            putStoredMessage: () => undefined,
            recordMessage: () => undefined,
            rememberOwnSend: () => undefined,
            recordLidMapping: () => undefined,
            getOnMessageCreate: () => undefined,
        };
        const original = Buffer.from('not decoded here');
        await new baileys_messaging_1.BaileysMessaging(host).sendTextMessage('628111@s.whatsapp.net', 'x', undefined, {
            customPreview: { url: 'https://example.com', title: 'Example', thumbnailBase64: original.toString('base64') },
        });
        expect(prepareWAMessageMedia).toHaveBeenCalledWith({ image: original }, expect.anything());
        expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    });
});
