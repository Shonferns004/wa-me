"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const baileys_messaging_1 = require("./baileys-messaging");
const message_not_found_error_1 = require("../../common/errors/message-not-found.error");
const logger_service_1 = require("../../common/services/logger.service");
const logger = (0, logger_service_1.createLogger)('baileys-click-button.spec');
const PROMPT = {
    key: { id: 'PROMPT-1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: {
        buttonsMessage: {
            contentText: 'Já é nosso cliente?',
            buttons: [
                { buttonId: 'yes', buttonText: { displayText: 'Sim' } },
                { buttonId: 'no', buttonText: { displayText: 'Não' } },
            ],
        },
    },
};
const LIST_PROMPT = {
    key: { id: 'PROMPT-LIST', remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: {
        listMessage: {
            sections: [
                {
                    rows: [
                        { rowId: 'ship_express', title: 'Express' },
                        { rowId: 'ship_std', title: 'Standard' },
                    ],
                },
            ],
        },
    },
};
const TEMPLATE_PROMPT = {
    key: { id: 'PROMPT-TPL', remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: {
        templateMessage: {
            hydratedTemplate: {
                hydratedButtons: [
                    { index: 1, urlButton: { url: 'https://pay.example', displayText: 'Pay now' } },
                    { index: 2, quickReplyButton: { id: 'yes', displayText: 'Sim' } },
                ],
            },
        },
    },
};
function contentTypeOf(message) {
    const content = message;
    if (content?.buttonsMessage)
        return 'buttonsMessage';
    if (content?.templateMessage)
        return 'templateMessage';
    if (content?.listMessage)
        return 'listMessage';
    if (content?.interactiveMessage)
        return 'interactiveMessage';
    return undefined;
}
function makeMessaging(stored = PROMPT, opts = {}) {
    const sendMessage = jest.fn().mockResolvedValue({
        key: { id: 'CLICK-1', remoteJid: '628111@s.whatsapp.net', fromMe: true },
        messageTimestamp: 1700000000,
    });
    const sock = { sendMessage, onWhatsApp: jest.fn((jid) => Promise.resolve([{ jid, exists: true }])) };
    const getStoredMessage = jest.fn().mockResolvedValue(stored);
    const putStoredMessage = jest.fn();
    const getEphemeralExpiration = jest.fn().mockReturnValue(opts.ephemeralExpiration);
    const host = {
        ensureReady: jest.fn(),
        sessionProxyUrl: () => undefined,
        getSocket: () => sock,
        getSocketOrNull: () => sock,
        logger,
        toNeutralJid: (j) => j.replace('@c.us', '@s.whatsapp.net'),
        toEngineJid: (j) => j,
        normalizedSelfJid: () => '628177@s.whatsapp.net',
        getEphemeralExpiration,
        toUnixSeconds: (ts) => typeof ts === 'number' ? ts : ts && 'toNumber' in ts ? ts.toNumber() : 0,
        loadLib: () => Promise.resolve({
            normalizeMessageContent: (c) => c,
            getContentType: (c) => contentTypeOf(c),
        }),
        getStoredMessage,
        wasDeletedForEveryone: () => false,
        pendingEditOf: () => undefined,
        markDeletedForEveryone: () => undefined,
        putStoredMessage,
        recordMessage: () => undefined,
        rememberOwnSend: () => undefined,
        recordLidMapping: () => undefined,
        getOnMessageCreate: () => undefined,
        mapMessage: () => Promise.resolve({}),
    };
    return {
        messaging: new baileys_messaging_1.BaileysMessaging(host),
        sendMessage,
        getStoredMessage,
        putStoredMessage,
        getEphemeralExpiration,
    };
}
const contentOf = (sendMessage) => {
    const [, content] = sendMessage.mock.calls[0];
    return content;
};
const optionsOf = (sendMessage) => {
    const [, , options] = sendMessage.mock.calls[0];
    return options ?? {};
};
describe('BaileysMessaging.clickButton', () => {
    it('sends a plain buttonReply quoted to the stored prompt', async () => {
        const { messaging, sendMessage, putStoredMessage } = makeMessaging();
        const result = await messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-1', 'yes', 'Sim');
        expect(contentOf(sendMessage)).toEqual({
            buttonReply: { displayText: 'Sim', id: 'yes', index: 0 },
            type: 'plain',
        });
        expect(optionsOf(sendMessage)).toEqual(expect.objectContaining({ quoted: PROMPT }));
        expect(putStoredMessage).toHaveBeenCalled();
        expect(result).toEqual({ id: 'CLICK-1', timestamp: 1700000000, body: 'Sim' });
    });
    it('sends a listReply for a listMessage prompt', async () => {
        const { messaging, sendMessage } = makeMessaging(LIST_PROMPT);
        await messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-LIST', 'ship_std');
        expect(contentOf(sendMessage)).toEqual({
            listReply: {
                title: 'Standard',
                listType: 1,
                singleSelectReply: { selectedRowId: 'ship_std' },
            },
        });
    });
    it('sends a template buttonReply using the hydrated button index', async () => {
        const { messaging, sendMessage } = makeMessaging(TEMPLATE_PROMPT);
        await messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-TPL', 'yes');
        expect(contentOf(sendMessage)).toEqual({
            buttonReply: { displayText: 'Sim', id: 'yes', index: 2 },
            type: 'template',
        });
    });
    it('passes the chat disappearing-messages timer on the click send', async () => {
        const { messaging, sendMessage } = makeMessaging(PROMPT, { ephemeralExpiration: 604800 });
        await messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-1', 'yes', 'Sim');
        expect(optionsOf(sendMessage)).toEqual(expect.objectContaining({ quoted: PROMPT, ephemeralExpiration: 604800 }));
    });
    it('404s when the prompt is not in the store', async () => {
        const { messaging } = makeMessaging(null);
        await expect(messaging.clickButton('628111@s.whatsapp.net', 'MISSING', 'yes')).rejects.toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
    });
    it('404s when the prompt belongs to a different chat', async () => {
        const otherChat = {
            ...PROMPT,
            key: { ...PROMPT.key, remoteJid: '628999@s.whatsapp.net' },
        };
        const { messaging, sendMessage } = makeMessaging(otherChat);
        await expect(messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-1', 'yes')).rejects.toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
        expect(sendMessage).not.toHaveBeenCalled();
    });
    it('400s when buttonId is not among the prompt choices', async () => {
        const { messaging } = makeMessaging();
        await expect(messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-1', 'maybe')).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
});
