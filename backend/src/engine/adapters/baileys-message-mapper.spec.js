"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const message_mapper_1 = require("./message-mapper");
const baileys_message_mapper_1 = require("./baileys-message-mapper");
describe('mapBaileysMessageType (baileys content-type -> neutral MessageType)', () => {
    it.each([
        ['conversation', false, 'text'],
        ['extendedTextMessage', false, 'text'],
        ['imageMessage', false, 'image'],
        ['videoMessage', false, 'video'],
        // A round video note is a VideoMessage under its own key.
        ['ptvMessage', false, 'video'],
        ['audioMessage', false, 'audio'],
        ['audioMessage', true, 'voice'],
        ['documentMessage', false, 'document'],
        ['stickerMessage', false, 'sticker'],
        ['locationMessage', false, 'location'],
        ['contactMessage', false, 'contact'],
        // WhatsApp Business interactive shapes carry their display text (e.g. OTP codes) and are flattened
        // to `text` so consumers render them and read the body over the standard API (#562).
        ['interactiveMessage', false, 'text'],
        ['buttonsMessage', false, 'text'],
        ['templateMessage', false, 'text'],
        ['interactiveResponseMessage', false, 'text'],
        ['buttonsResponseMessage', false, 'text'],
        ['templateButtonReplyMessage', false, 'text'],
        ['listResponseMessage', false, 'text'],
        ['listMessage', false, 'text'],
        // Meta masks high-security business messages (enterprise OTPs) on linked/companion devices,
        // delivering a bodyless `placeholderMessage` (PlaceholderType MASK_LINKED_DEVICES). Surface it as
        // its own `masked` type so it is distinguishable from a genuinely unparseable message (#574).
        ['placeholderMessage', false, 'masked'],
        [undefined, false, 'unknown'],
        // Native polls surface as their own `poll` type (WhatsApp bumps the content key across versions).
        ['pollCreationMessage', false, 'poll'],
        ['pollCreationMessageV2', false, 'poll'],
        ['pollCreationMessageV3', false, 'poll'],
        ['pollCreationMessageV4', false, 'poll'],
        ['pollCreationMessageV5', false, 'poll'],
        // A vote changes a poll and carries nothing of its own; it is never a poll itself.
        ['pollUpdateMessage', false, 'unknown'],
        // Regression trap: calls arrive via the `call` socket event, never as a message content type,
        // so any call-ish token must stay 'unknown' (no accidental mapping).
        ['callLogMessage', false, 'unknown'],
        // WhatsApp Business commerce shapes carry ids the commerce APIs need, so they get their own
        // types instead of collapsing to a bodyless `unknown`.
        ['orderMessage', false, 'order'],
        ['productMessage', false, 'product'],
    ])('maps %s (ptt=%s) -> %s', (raw, ptt, expected) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        expect((0, baileys_message_mapper_1.mapBaileysMessageType)(raw, ptt)).toBe(expected);
    });
});
describe('mapBaileysStatus (proto WAMessageStatus -> neutral DeliveryStatus)', () => {
    it.each([
        [0, 'failed'],
        [1, 'pending'],
        [2, 'sent'],
        [3, 'delivered'],
        [4, 'read'],
        [5, 'read'], // PLAYED collapses to read, mirroring the wwjs adapter
    ])('maps status %s -> %s', (status, expected) => {
        expect((0, baileys_message_mapper_1.mapBaileysStatus)(status)).toBe(expected);
    });
    it('returns null for an unknown/absent status so the adapter skips the ack', () => {
        expect((0, baileys_message_mapper_1.mapBaileysStatus)(undefined)).toBeNull();
        expect((0, baileys_message_mapper_1.mapBaileysStatus)(99)).toBeNull();
    });
});
describe('extractBaileysBody (inbound text/caption + interactive shapes)', () => {
    it('returns plain conversation text', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ conversation: 'hi' })).toBe('hi');
    });
    it('falls back to extendedTextMessage text', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ extendedTextMessage: { text: 'hey' } })).toBe('hey');
    });
    it('falls back to a media caption', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ imageMessage: { caption: 'pic' } })).toBe('pic');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ videoMessage: { caption: 'clip' } })).toBe('clip');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ documentMessage: { caption: 'doc' } })).toBe('doc');
    });
    // #562: business interactive messages (OTP/verification codes) were dropped as empty body.
    it('extracts interactiveMessage body text', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ interactiveMessage: { body: { text: 'Your code is 123456' } } })).toBe('Your code is 123456');
    });
    it('extracts buttonsMessage contentText', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ buttonsMessage: { contentText: 'Verification: 987654' } })).toBe('Verification: 987654');
    });
    it('extracts templateMessage hydrated content text (both field aliases)', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ templateMessage: { hydratedTemplate: { hydratedContentText: 'OTP 4242' } } })).toBe('OTP 4242');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ templateMessage: { hydratedFourRowTemplate: { hydratedContentText: 'OTP 1111' } } })).toBe('OTP 1111');
    });
    it('extracts interactiveResponseMessage body text', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ interactiveResponseMessage: { body: { text: 'Selected: Yes' } } })).toBe('Selected: Yes');
    });
    it('prefers plain text over an interactive fallback when both are present', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ conversation: 'plain', interactiveMessage: { body: { text: 'ignored' } } })).toBe('plain');
    });
    it('returns empty string when no extractable text is present', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({})).toBe('');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ interactiveMessage: {} })).toBe('');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ templateMessage: {} })).toBe('');
    });
    it('extracts a single shared contact card as its raw vCard', () => {
        const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Alice\nEND:VCARD';
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ contactMessage: { vcard } })).toBe(vcard);
    });
    it('joins multiple shared contact cards, one vCard per line, in order', () => {
        const alice = 'BEGIN:VCARD\nFN:Alice\nEND:VCARD';
        const bob = 'BEGIN:VCARD\nFN:Bob\nEND:VCARD';
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ contactsArrayMessage: { contacts: [{ vcard: alice }, { vcard: bob }] } })).toBe(`${alice}\n${bob}`);
    });
    it('skips a contactsArrayMessage entry with no vCard rather than injecting an empty line', () => {
        const alice = 'BEGIN:VCARD\nFN:Alice\nEND:VCARD';
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ contactsArrayMessage: { contacts: [{ vcard: alice }, { vcard: null }] } })).toBe(alice);
    });
    it('falls through to empty string for an empty contactsArrayMessage', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ contactsArrayMessage: { contacts: [] } })).toBe('');
    });
    it('prefers plain text over a contact card when somehow both are present', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ conversation: 'plain', contactMessage: { vcard: 'ignored' } })).toBe('plain');
    });
    it('extracts an inbound poll question across the wire content-key variants', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ pollCreationMessage: { name: 'Lunch order?' } })).toBe('Lunch order?');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ pollCreationMessageV2: { name: 'Team offsite?' } })).toBe('Team offsite?');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ pollCreationMessageV3: { name: 'Standup time?' } })).toBe('Standup time?');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ pollCreationMessageV5: { name: 'Quiz?' } })).toBe('Quiz?');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ pollCreationMessageV4: { message: { pollCreationMessage: { name: 'Wrapped?' } } } })).toBe('Wrapped?');
    });
    it('reads a V4 poll one level down only, and nothing but a poll from inside it', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({
            pollCreationMessageV4: {
                message: { pollCreationMessageV4: { message: { pollCreationMessage: { name: 'Deep' } } } },
            },
        })).toBe('');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ pollCreationMessageV4: { message: { conversation: 'not a poll' } } })).toBe('');
    });
    it('returns empty for a poll with no name rather than falling through to other sources', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ pollCreationMessage: {} })).toBe('');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ pollCreationMessage: { name: null } })).toBe('');
    });
    it('extracts a shared event display name', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ eventMessage: { name: 'Release party' } })).toBe('Release party');
    });
    it('extracts which business button label the user tapped', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ buttonsResponseMessage: { selectedDisplayText: 'Yes, notify me' } })).toBe('Yes, notify me');
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ templateButtonReplyMessage: { selectedDisplayText: 'Track order' } })).toBe('Track order');
    });
    it('extracts a list-row title the user selected', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ listResponseMessage: { title: 'Express shipping' } })).toBe('Express shipping');
    });
});
describe('setBaileysText (an edit written back where extractBaileysBody reads it)', () => {
    it.each([
        ['a plain text', { conversation: 'before' }],
        ['an extended text', { extendedTextMessage: { text: 'before', matchedText: 'https://example.com' } }],
        ['a photo caption', { imageMessage: { caption: 'before', url: 'https://mmg.example/x' } }],
        ['a video caption', { videoMessage: { caption: 'before' } }],
        ['a document caption', { documentMessage: { caption: 'before', fileName: 'a.pdf' } }],
    ])('rewrites %s and keeps the rest of the content', (_kind, content) => {
        const copy = structuredClone(content);
        expect((0, baileys_message_mapper_1.setBaileysText)(copy, 'after')).toBe(true);
        expect((0, baileys_message_mapper_1.extractBaileysBody)(copy)).toBe('after');
        // Only the text slot moved: the same object with the new text is what remains.
        expect((0, baileys_message_mapper_1.setBaileysText)(copy, 'before')).toBe(true);
        expect(copy).toEqual(content);
    });
    it('changes nothing on content with no text slot', () => {
        const content = { locationMessage: { degreesLatitude: 1 } };
        expect((0, baileys_message_mapper_1.setBaileysText)(content, 'after')).toBe(false);
        expect(content).toEqual({ locationMessage: { degreesLatitude: 1 } });
    });
});
describe('extractBaileysContext (quoted body shares the live body extractor)', () => {
    const quoted = (quotedMessage) => (0, baileys_message_mapper_1.extractBaileysContext)({
        imageMessage: { contextInfo: { stanzaId: 'wamid.original', quotedMessage } },
    }).quotedMessage;
    it('carries a quoted contact card as its vCard', () => {
        const vcard = 'BEGIN:VCARD\nFN:Alice\nEND:VCARD';
        expect(quoted({ contactMessage: { vcard } })).toEqual({ id: 'wamid.original', body: vcard });
    });
    it('carries a quoted poll question', () => {
        expect(quoted({ pollCreationMessage: { name: 'Lunch order?' } })?.body).toBe('Lunch order?');
    });
    it('still carries captions and plain text from the classic sources', () => {
        expect(quoted({ imageMessage: { caption: 'pic' } })?.body).toBe('pic');
        expect(quoted({ conversation: 'the original' })?.body).toBe('the original');
        expect(quoted({ stickerMessage: {} })?.body).toBe('');
    });
    it('reads the quote, timer and mentions off a video note', () => {
        expect((0, baileys_message_mapper_1.extractBaileysContext)({
            ptvMessage: {
                contextInfo: {
                    stanzaId: 'wamid.original',
                    quotedMessage: { conversation: 'the original' },
                    expiration: 86400,
                    mentionedJid: ['628222@s.whatsapp.net'],
                },
            },
        })).toMatchObject({
            quotedMessage: { id: 'wamid.original', body: 'the original' },
            ephemeralDuration: 86400,
            mentionedJids: ['628222@s.whatsapp.net'],
        });
    });
    it.each([
        'productMessage',
        'contactMessage',
        'contactsArrayMessage',
        'pollCreationMessageV3',
        'liveLocationMessage',
        'orderMessage',
        'eventMessage',
    ])('reads the disappearing-messages timer off a %s', type => {
        const content = { [type]: { contextInfo: { expiration: 86400 } } };
        expect((0, baileys_message_mapper_1.extractBaileysContext)(content).ephemeralDuration).toBe(86400);
    });
    it('reads the disappearing-messages timer off the poll inside a pollCreationMessageV4', () => {
        const content = {
            pollCreationMessageV4: { message: { pollCreationMessage: { contextInfo: { expiration: 604800 } } } },
        };
        expect((0, baileys_message_mapper_1.extractBaileysContext)(content).ephemeralDuration).toBe(604800);
    });
    it('reads no timer when no content node carries one', () => {
        expect((0, baileys_message_mapper_1.extractBaileysContext)({ conversation: 'hi' }).ephemeralDuration).toBeUndefined();
    });
    it('carries a quote from a button-reply contextInfo', () => {
        expect((0, baileys_message_mapper_1.extractBaileysContext)({
            buttonsResponseMessage: {
                contextInfo: { stanzaId: 'wamid.prompt', quotedMessage: { conversation: 'Pick one' } },
            },
        }).quotedMessage).toEqual({ id: 'wamid.prompt', body: 'Pick one' });
    });
});
describe('buildIncomingMessageFromBaileys', () => {
    const base = {
        id: 'MSG1',
        remoteJid: '628111@s.whatsapp.net',
        fromMe: false,
        body: 'hi',
        contentType: 'conversation',
        timestamp: 1700000000,
        selfJid: '628999@s.whatsapp.net',
    };
    it('maps a 1:1 inbound message to the neutral shape (chatId, type, non-group)', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)(base);
        expect(r.id).toBe('MSG1');
        expect(r.chatId).toBe('628111@s.whatsapp.net');
        expect(r.from).toBe('628111@s.whatsapp.net');
        expect(r.to).toBe('628999@s.whatsapp.net');
        expect(r.type).toBe('text');
        expect(r.isGroup).toBe(false);
        expect(r.fromMe).toBe(false);
    });
    it('stamps kind from the chat JID', () => {
        expect((0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: 'abc@newsletter' }).kind).toBe('channel');
    });
    it('inverts from/to for an outgoing (fromMe) message', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, fromMe: true });
        expect(r.from).toBe('628999@s.whatsapp.net'); // self
        expect(r.to).toBe('628111@s.whatsapp.net'); // chat
    });
    it('applies the supplied normalizer to from/to/chatId on a 1:1 message', () => {
        const normalize = (jid) => jid.replace('@s.whatsapp.net', '@c.us');
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)(base, normalize);
        expect(r.from).toBe('628111@c.us');
        expect(r.to).toBe('628999@c.us');
        expect(r.chatId).toBe('628111@c.us');
    });
    it('normalizes the group author and self while leaving the group JID intact', () => {
        const normalize = (jid) => jid.replace('@s.whatsapp.net', '@c.us');
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: '123-456@g.us', participant: '628222@s.whatsapp.net' }, normalize);
        expect(r.from).toBe('123-456@g.us'); // group jid untouched by this normalizer
        expect(r.to).toBe('628999@c.us'); // self normalized
        expect(r.author).toBe('628222@c.us'); // participant normalized
    });
    it('sets author to the participant for a group message and flags isGroup', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            ...base,
            remoteJid: '123-456@g.us',
            participant: '628222@s.whatsapp.net',
        });
        expect(r.isGroup).toBe(true);
        expect(r.author).toBe('628222@s.whatsapp.net');
        expect(r.chatId).toBe('123-456@g.us');
        expect(r.from).toBe('123-456@g.us'); // group inbound: from is the group JID (mirrors wwjs)
        expect(r.to).toBe('628999@s.whatsapp.net'); // recipient is self
    });
    it('flags an @lid 1:1 sender', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: '111@lid' });
        expect(r.isLidSender).toBe(true);
    });
    it('flags an @lid group participant via participant, not the group JID', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            ...base,
            remoteJid: '123-456@g.us',
            participant: '222@lid',
        });
        expect(r.isLidSender).toBe(true);
    });
    it('reads an empty participant as none: a lid chat is still a lid sender and a group names no author', () => {
        // A live key goes through cleanMessage, which writes '' for the participant of a 1:1 chat.
        const direct = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: '111@lid', participant: '' });
        expect(direct.isLidSender).toBe(true);
        expect(direct.author).toBeUndefined();
        const group = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: '123-456@g.us', participant: '' });
        expect(group.author).toBeUndefined();
        expect(group.isLidSender).toBeFalsy();
    });
    it('flags a status broadcast', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: 'status@broadcast' });
        expect(r.isStatusBroadcast).toBe(true);
    });
    it('exposes the status poster from participant as author (status@broadcast is not a group)', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            ...base,
            remoteJid: 'status@broadcast',
            participant: '628111@s.whatsapp.net',
        });
        expect(r.isStatusBroadcast).toBe(true);
        expect(r.isGroup).toBe(false);
        // Without this, buildIncomingStatus can only resolve the poster to the status@broadcast
        // pseudo-JID itself and drops the status entirely.
        expect(r.author).toBe('628111@s.whatsapp.net');
    });
    it("files a received broadcast-list message under the sender's chat, as Baileys does", () => {
        const normalize = (jid) => jid.replace('@s.whatsapp.net', '@c.us');
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: '1700000000@broadcast', participant: '628222@s.whatsapp.net' }, normalize);
        expect(r.chatId).toBe('628222@c.us');
        expect(r.from).toBe('628222@c.us');
        expect(r.to).toBe('628999@c.us');
        expect(r.kind).toBe('individual');
        expect(r.isStatusBroadcast).toBe(false);
        expect(r.isGroup).toBe(false);
        expect(r.author).toBe('628222@c.us');
    });
    it('keeps the list as the chat for a received list message with no participant', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: '1700000000@broadcast' });
        expect(r.chatId).toBe('1700000000@broadcast');
        expect(r.kind).toBe('broadcast');
    });
    it('flags a lid sender of a received list message and files it under the lid', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: '1700000000@broadcast', participant: '222@lid' });
        expect(r.chatId).toBe('222@lid');
        expect(r.isLidSender).toBe(true);
    });
    it('baileysChatJid mirrors Baileys getChatId without throwing', () => {
        const list = '1700000000@broadcast';
        const sender = '628222@s.whatsapp.net';
        expect((0, baileys_message_mapper_1.baileysChatJid)(list, sender, false)).toBe(sender);
        expect((0, baileys_message_mapper_1.baileysChatJid)(list, sender, true)).toBe(list);
        expect((0, baileys_message_mapper_1.baileysChatJid)(list, undefined, false)).toBe(list);
        expect((0, baileys_message_mapper_1.baileysChatJid)('status@broadcast', sender, false)).toBe('status@broadcast');
        expect((0, baileys_message_mapper_1.baileysChatJid)('120363@g.us', sender, false)).toBe('120363@g.us');
    });
    it('keeps the list as the chat for a broadcast-list message the account sent', () => {
        const normalize = (jid) => jid.replace('@s.whatsapp.net', '@c.us');
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, remoteJid: '1700000000@broadcast', fromMe: true, participant: '628999@s.whatsapp.net' }, normalize);
        expect(r.chatId).toBe('1700000000@broadcast');
        expect(r.from).toBe('628999@c.us');
        expect(r.to).toBe('1700000000@broadcast');
        expect(r.author).toBe('628999@c.us');
    });
    it('converts extended-text status styling: backgroundArgb -> #RRGGBB, font passed through', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            ...base,
            remoteJid: 'status@broadcast',
            participant: '628111@s.whatsapp.net',
            backgroundArgb: 0xff25d366, // ARGB, alpha in the high byte
            font: 2,
        });
        expect(r.backgroundColor).toBe('#25d366');
        expect(r.font).toBe(2);
    });
    it('leaves styling undefined when the message carries none', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base });
        expect(r.backgroundColor).toBeUndefined();
        expect(r.font).toBeUndefined();
    });
    it('carries the push name onto contact when present', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, pushName: 'Alice' });
        expect(r.contact).toEqual({ pushName: 'Alice' });
    });
    it('maps ephemeralDuration when present on the fields', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, ephemeralDuration: 604800 });
        expect(r.ephemeralDuration).toBe(604800);
    });
    it('omits ephemeralDuration when absent from the fields', () => {
        expect((0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)(base).ephemeralDuration).toBeUndefined();
    });
    it('omits ephemeralDuration when ephemeralDuration is 0', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, ephemeralDuration: 0 });
        expect(r.ephemeralDuration).toBeUndefined();
    });
    it('maps mentionedIds, normalizing each JID, when present', () => {
        const normalize = (jid) => jid.replace('@s.whatsapp.net', '@c.us');
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, mentionedJids: ['111@s.whatsapp.net', '222@s.whatsapp.net'] }, normalize);
        expect(r.mentionedIds).toEqual(['111@c.us', '222@c.us']);
    });
    it('omits mentionedIds when absent or empty', () => {
        expect((0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)(base).mentionedIds).toBeUndefined();
        expect((0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, mentionedJids: [] }).mentionedIds).toBeUndefined();
    });
    it('normalizes the catalog owner JID, so no commerce field escapes the @c.us convention', () => {
        const normalize = (jid) => jid.replace('@s.whatsapp.net', '@c.us');
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            ...base,
            contentType: 'productMessage',
            product: { productId: '2', title: 'Sample', businessOwnerJid: '100000000000@s.whatsapp.net' },
        }, normalize);
        expect(r.product).toEqual({ productId: '2', title: 'Sample', businessOwnerJid: '100000000000@c.us' });
    });
    it('carries the order through untouched, and types a catalog share as unknown', () => {
        expect((0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, contentType: 'orderMessage', order: { orderId: '1', token: 't' } })
            .order).toEqual({ orderId: '1', token: 't' });
        expect((0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({ ...base, contentType: 'productMessage', isCatalogShare: true }).type).toBe('unknown');
    });
    it('carries a button reply and types the reply content as text', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            ...base,
            contentType: 'buttonsResponseMessage',
            body: 'Yes, notify me',
            button: { id: 'btn_yes', text: 'Yes, notify me' },
        });
        expect(r.type).toBe('text');
        expect(r.button).toEqual({ id: 'btn_yes', text: 'Yes, notify me' });
    });
    it('fills body from the button label when the content body is empty', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            ...base,
            contentType: 'interactiveResponseMessage',
            body: '',
            button: { id: 'qr_1', text: 'Confirm' },
        });
        expect(r.body).toBe('Confirm');
        expect(r.button).toEqual({ id: 'qr_1', text: 'Confirm' });
    });
    it('carries prompt buttons on an inbound business message', () => {
        const r = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            ...base,
            contentType: 'buttonsMessage',
            body: 'Já é nosso cliente?',
            buttons: [
                { id: 'yes', text: 'Sim' },
                { id: 'no', text: 'Não' },
            ],
        });
        expect(r.type).toBe('text');
        expect(r.buttons).toEqual([
            { id: 'yes', text: 'Sim' },
            { id: 'no', text: 'Não' },
        ]);
    });
});
describe('extractBaileysButtonReply (button / list / native-flow ids)', () => {
    it('extracts a classic buttonsResponseMessage id and label', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtonReply)({
            buttonsResponseMessage: { selectedButtonId: 'btn_yes', selectedDisplayText: 'Yes, notify me' },
        }, 'buttonsResponseMessage')).toEqual({ id: 'btn_yes', text: 'Yes, notify me' });
    });
    it('extracts a templateButtonReplyMessage id and label', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtonReply)({
            templateButtonReplyMessage: { selectedId: 'track', selectedDisplayText: 'Track order' },
        }, 'templateButtonReplyMessage')).toEqual({ id: 'track', text: 'Track order' });
    });
    it('extracts a listResponseMessage row id and title', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtonReply)({
            listResponseMessage: {
                title: 'Express shipping',
                singleSelectReply: { selectedRowId: 'ship_express' },
            },
        }, 'listResponseMessage')).toEqual({ id: 'ship_express', text: 'Express shipping' });
    });
    it('extracts a native-flow interactiveResponseMessage id from paramsJson', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtonReply)({
            interactiveResponseMessage: {
                nativeFlowResponseMessage: {
                    name: 'quick_reply',
                    paramsJson: JSON.stringify({ id: 'qr_1', display_text: 'Confirm' }),
                },
            },
        }, 'interactiveResponseMessage')).toEqual({ id: 'qr_1', text: 'Confirm' });
    });
    it('accepts button_id / displayText aliases in native-flow params', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtonReply)({
            interactiveResponseMessage: {
                nativeFlowResponseMessage: {
                    paramsJson: JSON.stringify({ button_id: 'alt', displayText: 'OK' }),
                },
            },
        }, 'interactiveResponseMessage')).toEqual({ id: 'alt', text: 'OK' });
    });
    it('yields nothing when the actionable id is missing or the JSON is malformed', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtonReply)({ buttonsResponseMessage: { selectedDisplayText: 'Yes' } }, 'buttonsResponseMessage')).toBeUndefined();
        expect((0, baileys_message_mapper_1.extractBaileysButtonReply)({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{not-json' } } }, 'interactiveResponseMessage')).toBeUndefined();
        expect((0, baileys_message_mapper_1.extractBaileysButtonReply)({
            interactiveResponseMessage: {
                nativeFlowResponseMessage: { paramsJson: JSON.stringify({ display_text: 'OK' }) },
            },
        }, 'interactiveResponseMessage')).toBeUndefined();
        expect((0, baileys_message_mapper_1.extractBaileysButtonReply)({}, 'conversation')).toBeUndefined();
    });
});
describe('extractBaileysButtons (prompt choices Sim/Não / list rows)', () => {
    it('extracts classic buttonsMessage choices', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtons)({
            buttonsMessage: {
                buttons: [
                    { buttonId: 'yes', buttonText: { displayText: 'Sim' } },
                    { buttonId: 'no', buttonText: { displayText: 'Não' } },
                ],
            },
        }, 'buttonsMessage')).toEqual([
            { id: 'yes', text: 'Sim' },
            { id: 'no', text: 'Não' },
        ]);
    });
    it('drops a native-flow CTA carried inside a classic buttonsMessage', () => {
        // The same envelope can hold both a reply button and a CTA that opens a URL or dials a number.
        // A CTA cannot be answered, so publishing it would offer a choice the click route must refuse.
        expect((0, baileys_message_mapper_1.extractBaileysButtons)({
            buttonsMessage: {
                buttons: [
                    { buttonId: 'yes', buttonText: { displayText: 'Sim' } },
                    {
                        buttonId: 'docs',
                        buttonText: { displayText: 'Open the docs' },
                        nativeFlowInfo: { name: 'cta_url' },
                    },
                ],
            },
        }, 'buttonsMessage')).toEqual([{ id: 'yes', text: 'Sim' }]);
    });
    it('keeps a native-flow quick reply carried inside a classic buttonsMessage', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtons)({
            buttonsMessage: {
                buttons: [
                    {
                        buttonId: 'yes',
                        buttonText: { displayText: 'Sim' },
                        nativeFlowInfo: { name: 'quick_reply' },
                    },
                ],
            },
        }, 'buttonsMessage')).toEqual([{ id: 'yes', text: 'Sim' }]);
    });
    it('keeps one index namespace for a template that numbers only some of its buttons', () => {
        // selectedIndex goes back to the business bot verbatim. Falling back to the array position for
        // an unnumbered entry can hand the bot a number belonging to a different button, so an entry the
        // template did not number carries no index at all. It is still offered: the user can see and tap
        // it in WhatsApp, and the reply names it by id.
        const prompt = {
            templateMessage: {
                hydratedTemplate: {
                    hydratedButtons: [
                        { index: 5, quickReplyButton: { id: 'yes', displayText: 'Sim' } },
                        { quickReplyButton: { id: 'maybe', displayText: 'Talvez' } },
                        { index: 7, quickReplyButton: { id: 'no', displayText: 'Não' } },
                    ],
                },
            },
        };
        expect((0, baileys_message_mapper_1.extractBaileysButtons)(prompt, 'templateMessage')).toEqual([
            { id: 'yes', text: 'Sim' },
            { id: 'maybe', text: 'Talvez' },
            { id: 'no', text: 'Não' },
        ]);
        expect((0, baileys_message_mapper_1.extractBaileysClickableButtons)(prompt, 'templateMessage')).toEqual([
            { id: 'yes', text: 'Sim', index: 5 },
            { id: 'maybe', text: 'Talvez', index: undefined },
            { id: 'no', text: 'Não', index: 7 },
        ]);
    });
    it('offers the quick replies of a template whose only numbered button is a CTA', () => {
        // The CTA is never offered, so its index was the only thing making the prompt look numbered.
        // Requiring an index of every entry emptied the whole prompt, which is how a visible Sim/Não
        // pair disappeared from buttons[] and was then refused by the click route.
        const prompt = {
            templateMessage: {
                hydratedTemplate: {
                    hydratedButtons: [
                        { index: 1, urlButton: { displayText: 'Open', url: 'https://example.com' } },
                        { quickReplyButton: { id: 'yes', displayText: 'Sim' } },
                        { quickReplyButton: { id: 'no', displayText: 'Não' } },
                    ],
                },
            },
        };
        expect((0, baileys_message_mapper_1.extractBaileysButtons)(prompt, 'templateMessage')).toEqual([
            { id: 'yes', text: 'Sim' },
            { id: 'no', text: 'Não' },
        ]);
        expect((0, baileys_message_mapper_1.extractBaileysClickableButtons)(prompt, 'templateMessage')).toEqual([
            { id: 'yes', text: 'Sim', index: undefined },
            { id: 'no', text: 'Não', index: undefined },
        ]);
    });
    it('numbers by array position when the template carries no indices at all', () => {
        // Asserted through the clickable list, which keeps the index; extractBaileysButtons projects it
        // away, so it cannot tell a correct position from any other number.
        expect((0, baileys_message_mapper_1.extractBaileysClickableButtons)({
            templateMessage: {
                hydratedTemplate: {
                    hydratedButtons: [
                        { quickReplyButton: { id: 'yes', displayText: 'Sim' } },
                        { quickReplyButton: { id: 'no', displayText: 'Não' } },
                    ],
                },
            },
        }, 'templateMessage')).toEqual([
            { id: 'yes', text: 'Sim', index: 0 },
            { id: 'no', text: 'Não', index: 1 },
        ]);
    });
    it('extracts interactiveMessage native-flow quick replies', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtons)({
            interactiveMessage: {
                nativeFlowMessage: {
                    buttons: [
                        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ id: 'yes', display_text: 'Sim' }) },
                        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ id: 'no', display_text: 'Não' }) },
                    ],
                },
            },
        }, 'interactiveMessage')).toEqual([
            { id: 'yes', text: 'Sim' },
            { id: 'no', text: 'Não' },
        ]);
    });
    it('extracts listMessage rows as buttons', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtons)({
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
        }, 'listMessage')).toEqual([
            { id: 'ship_express', text: 'Express' },
            { id: 'ship_std', text: 'Standard' },
        ]);
    });
    it('extracts templateMessage quick-replies and drops url/call CTAs', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtons)({
            templateMessage: {
                hydratedTemplate: {
                    hydratedButtons: [
                        { index: 1, urlButton: { url: 'https://pay.example', displayText: 'Pay now' } },
                        { index: 2, quickReplyButton: { id: 'yes', displayText: 'Sim' } },
                        { index: 3, callButton: { phoneNumber: '+15551212', displayText: 'Call us' } },
                    ],
                },
            },
        }, 'templateMessage')).toEqual([{ id: 'yes', text: 'Sim' }]);
    });
    it('drops native-flow CTA names so published buttons agree with the click allowlist', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtons)({
            interactiveMessage: {
                nativeFlowMessage: {
                    buttons: [
                        { name: 'cta_url', buttonParamsJson: JSON.stringify({ id: 'docs', display_text: 'Docs' }) },
                        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ id: 'yes', display_text: 'Sim' }) },
                    ],
                },
            },
        }, 'interactiveMessage')).toEqual([{ id: 'yes', text: 'Sim' }]);
    });
    it('caps the number of choices and the length of each label', () => {
        const rows = Array.from({ length: baileys_message_mapper_1.BUTTONS_MAX_ENTRIES + 5 }, (_, i) => ({
            rowId: `row_${i}`,
            title: 'x'.repeat(baileys_message_mapper_1.BUTTON_TEXT_MAX_LENGTH + 10),
        }));
        const buttons = (0, baileys_message_mapper_1.extractBaileysButtons)({ listMessage: { sections: [{ rows }] } }, 'listMessage');
        expect(buttons).toHaveLength(baileys_message_mapper_1.BUTTONS_MAX_ENTRIES);
        expect(buttons[0].text).toHaveLength(baileys_message_mapper_1.BUTTON_TEXT_MAX_LENGTH);
        expect(buttons[0].id).toBe('row_0');
    });
    // A row id goes back to the business bot verbatim on a click, so an over-long one is dropped
    // rather than rewritten into an id the bot would not recognise; only the label is trimmed.
    it('drops a choice whose id is over the cap instead of truncating it', () => {
        const rows = [
            { rowId: 'r'.repeat(baileys_message_mapper_1.BUTTON_TEXT_MAX_LENGTH + 1), title: 'too long to send back' },
            { rowId: 'ok', title: 'fine' },
        ];
        const buttons = (0, baileys_message_mapper_1.extractBaileysButtons)({ listMessage: { sections: [{ rows }] } }, 'listMessage');
        expect(buttons).toEqual([{ id: 'ok', text: 'fine' }]);
    });
    it('yields nothing for a non-prompt content type', () => {
        expect((0, baileys_message_mapper_1.extractBaileysButtons)({}, 'conversation')).toBeUndefined();
        expect((0, baileys_message_mapper_1.extractBaileysButtons)({ buttonsMessage: { buttons: [] } }, 'buttonsMessage')).toBeUndefined();
    });
});
describe('resolveBaileysButtonClick (API click against a stored prompt)', () => {
    it('builds a plain buttonReply for a classic buttonsMessage prompt', () => {
        const result = (0, baileys_message_mapper_1.resolveBaileysButtonClick)({
            buttonsMessage: {
                buttons: [
                    { buttonId: 'yes', buttonText: { displayText: 'Sim' } },
                    { buttonId: 'no', buttonText: { displayText: 'Não' } },
                ],
            },
        }, 'buttonsMessage', 'yes');
        expect(result).toEqual({
            ok: true,
            payload: {
                id: 'yes',
                text: 'Sim',
                index: 0,
                content: {
                    buttonReply: { displayText: 'Sim', id: 'yes', index: 0 },
                    type: 'plain',
                },
            },
        });
    });
    it('answers a choice a numbered template left unnumbered with no selectedIndex', () => {
        // `selectedIndex` has explicit presence on the wire and Baileys drops an undefined field before
        // encoding, so the bot receives the id and the label and no number at all, which is honest.
        // Fabricating a position here could name a different button in the template's own numbering.
        const result = (0, baileys_message_mapper_1.resolveBaileysButtonClick)({
            templateMessage: {
                hydratedTemplate: {
                    hydratedButtons: [
                        { index: 5, quickReplyButton: { id: 'yes', displayText: 'Sim' } },
                        { quickReplyButton: { id: 'maybe', displayText: 'Talvez' } },
                    ],
                },
            },
        }, 'templateMessage', 'maybe');
        expect(result).toEqual({
            ok: true,
            payload: {
                id: 'maybe',
                text: 'Talvez',
                index: undefined,
                content: {
                    buttonReply: { displayText: 'Talvez', id: 'maybe', index: undefined },
                    type: 'template',
                },
            },
        });
    });
    it('rejects an unknown buttonId and a non-prompt content type', () => {
        expect((0, baileys_message_mapper_1.resolveBaileysButtonClick)({ buttonsMessage: { buttons: [{ buttonId: 'yes', buttonText: { displayText: 'Sim' } }] } }, 'buttonsMessage', 'nope')).toEqual({ ok: false, error: 'unknown_button' });
        expect((0, baileys_message_mapper_1.resolveBaileysButtonClick)({}, 'conversation', 'yes')).toEqual({ ok: false, error: 'not_a_prompt' });
    });
    it('skips cta_url interactive buttons so only quick_reply is clickable', () => {
        const result = (0, baileys_message_mapper_1.resolveBaileysButtonClick)({
            interactiveMessage: {
                nativeFlowMessage: {
                    buttons: [
                        {
                            name: 'cta_url',
                            buttonParamsJson: JSON.stringify({ id: 'docs', display_text: 'Docs', url: 'https://x' }),
                        },
                        {
                            name: 'quick_reply',
                            buttonParamsJson: JSON.stringify({ id: 'yes', display_text: 'Sim' }),
                        },
                    ],
                },
            },
        }, 'interactiveMessage', 'yes');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.payload.content).toEqual({
                buttonReply: { displayText: 'Sim', id: 'yes', index: 1 },
                type: 'template',
            });
        }
        expect((0, baileys_message_mapper_1.resolveBaileysButtonClick)({
            interactiveMessage: {
                nativeFlowMessage: {
                    buttons: [
                        {
                            name: 'cta_url',
                            buttonParamsJson: JSON.stringify({ id: 'docs', display_text: 'Docs', url: 'https://x' }),
                        },
                    ],
                },
            },
        }, 'interactiveMessage', 'docs')).toEqual({ ok: false, error: 'not_a_prompt' });
    });
    it('uses the hydrated template button index, not the filtered-list offset', () => {
        const result = (0, baileys_message_mapper_1.resolveBaileysButtonClick)({
            templateMessage: {
                hydratedTemplate: {
                    hydratedButtons: [
                        { index: 1, urlButton: { url: 'https://pay.example', displayText: 'Pay now' } },
                        { index: 2, quickReplyButton: { id: 'yes', displayText: 'Sim' } },
                    ],
                },
            },
        }, 'templateMessage', 'yes');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.payload.index).toBe(2);
            expect(result.payload.content).toEqual({
                buttonReply: { displayText: 'Sim', id: 'yes', index: 2 },
                type: 'template',
            });
        }
    });
    it('builds a listReply for a listMessage prompt', () => {
        const result = (0, baileys_message_mapper_1.resolveBaileysButtonClick)({
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
        }, 'listMessage', 'ship_std');
        expect(result).toEqual({
            ok: true,
            payload: {
                id: 'ship_std',
                text: 'Standard',
                index: 1,
                content: {
                    listReply: {
                        title: 'Standard',
                        listType: 1,
                        singleSelectReply: { selectedRowId: 'ship_std' },
                    },
                },
            },
        });
    });
    it('disambiguates duplicate list row ids by the caller-supplied text', () => {
        const prompt = {
            listMessage: {
                sections: [{ rows: [{ rowId: 'same', title: 'Morning' }] }, { rows: [{ rowId: 'same', title: 'Evening' }] }],
            },
        };
        const evening = (0, baileys_message_mapper_1.resolveBaileysButtonClick)(prompt, 'listMessage', 'same', 'Evening');
        expect(evening.ok).toBe(true);
        if (evening.ok) {
            expect(evening.payload.text).toBe('Evening');
            expect(evening.payload.index).toBe(1);
        }
    });
});
describe('toBaileysButtonClickContent', () => {
    it('uses the plain buttonReply helper for buttonsMessage', () => {
        expect((0, baileys_message_mapper_1.toBaileysButtonClickContent)('buttonsMessage', 'yes', 'Sim', 0)).toEqual({
            buttonReply: { displayText: 'Sim', id: 'yes', index: 0 },
            type: 'plain',
        });
    });
});
describe('extractBaileysCommerce (order / product ids)', () => {
    // Field-for-field shape of an inbound order as WhatsApp sends it; ids and token are placeholders.
    const orderContent = {
        orderMessage: {
            orderId: '1000000000000001',
            token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        },
    };
    it('extracts the order id and its single-order token', () => {
        expect((0, baileys_message_mapper_1.extractBaileysCommerce)(orderContent, 'orderMessage').order).toEqual({
            orderId: '1000000000000001',
            token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        });
    });
    it('keeps the order id when no token came with it', () => {
        const { order } = (0, baileys_message_mapper_1.extractBaileysCommerce)({ orderMessage: { orderId: '1' } }, 'orderMessage');
        expect(order).toEqual({ orderId: '1', token: undefined });
    });
    it('extracts the product id and its descriptive fields from a shared product card', () => {
        const { product } = (0, baileys_message_mapper_1.extractBaileysCommerce)({
            productMessage: {
                businessOwnerJid: '100000000000@s.whatsapp.net',
                product: { productId: '2000000000000002', title: 'Sample', description: 'A sample' },
            },
        }, 'productMessage');
        expect(product).toEqual({
            productId: '2000000000000002',
            title: 'Sample',
            description: 'A sample',
            businessOwnerJid: '100000000000@s.whatsapp.net',
        });
    });
    it('yields nothing when the id that makes it actionable is missing', () => {
        expect((0, baileys_message_mapper_1.extractBaileysCommerce)({ orderMessage: { token: 'x' } }, 'orderMessage')).toEqual({});
        expect((0, baileys_message_mapper_1.extractBaileysCommerce)({ productMessage: { product: { title: 'A' } } }, 'productMessage')).toEqual({});
    });
    it('yields nothing for a non-commerce content type', () => {
        expect((0, baileys_message_mapper_1.extractBaileysCommerce)(orderContent, 'conversation')).toEqual({});
        expect((0, baileys_message_mapper_1.extractBaileysCommerce)({}, undefined)).toEqual({});
    });
});
describe('isBaileysCatalogShare (the productMessage arm with no product)', () => {
    // There is no `catalogMessage` content type: sharing a whole catalog sends a `productMessage`
    // carrying `catalog` instead of `product`, which would otherwise surface as a `product` message
    // with no product object and an empty body.
    it('detects the catalog arm and maps it to unknown rather than product', () => {
        const content = { productMessage: { catalog: { title: 'Storefront' } } };
        expect((0, baileys_message_mapper_1.isBaileysCatalogShare)(content)).toBe(true);
        expect((0, baileys_message_mapper_1.mapBaileysMessageType)('productMessage', false, true)).toBe('unknown');
        expect((0, baileys_message_mapper_1.extractBaileysCommerce)(content, 'productMessage')).toEqual({});
    });
    it('flattens the catalog title into the body so the message is not empty', () => {
        expect((0, baileys_message_mapper_1.extractBaileysBody)({ productMessage: { catalog: { title: 'Storefront' } } })).toBe('Storefront');
    });
    it('is false for a real product card, and for a productMessage carrying both arms', () => {
        expect((0, baileys_message_mapper_1.isBaileysCatalogShare)({ productMessage: { product: { productId: '2' } } })).toBe(false);
        expect((0, baileys_message_mapper_1.isBaileysCatalogShare)({ productMessage: { product: { productId: '2' }, catalog: { title: 'S' } } })).toBe(false);
    });
});
describe('native poll choice metadata', () => {
    // Every content key a poll travels under. pollCreationMessageV4 wraps a whole message, with the poll inside it.
    const shapes = [
        ['pollCreationMessage', poll => ({ pollCreationMessage: poll })],
        ['pollCreationMessageV2', poll => ({ pollCreationMessageV2: poll })],
        ['pollCreationMessageV3', poll => ({ pollCreationMessageV3: poll })],
        ['pollCreationMessageV5', poll => ({ pollCreationMessageV5: poll })],
        ...['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'pollCreationMessageV5'].map((inner) => [
            `pollCreationMessageV4 around ${inner}`,
            poll => ({ pollCreationMessageV4: { message: { [inner]: poll } } }),
        ]),
    ];
    it.each(shapes)('reads %s without changing option texts', (_label, wrap) => {
        expect((0, baileys_message_mapper_1.extractBaileysPoll)(wrap({
            name: 'Where?',
            options: [{ optionName: ' Park ' }, { optionName: 'Beach' }],
            selectableOptionsCount: 1,
        }))).toEqual({ name: 'Where?', options: [' Park ', 'Beach'], allowMultipleAnswers: false });
    });
    it('reads a V5 quiz as its question and options, with the correct answer kept out of the options', () => {
        expect((0, baileys_message_mapper_1.extractBaileysPoll)({
            pollCreationMessageV5: {
                name: 'Capital of France?',
                options: [{ optionName: 'Paris' }, { optionName: 'Lyon' }],
                selectableOptionsCount: 1,
                pollType: 1,
                correctAnswer: { optionName: 'Paris' },
            },
        })).toEqual({ name: 'Capital of France?', options: ['Paris', 'Lyon'], allowMultipleAnswers: false });
    });
    it('opens a V4 wrapper one level only', () => {
        const poll = { name: 'Deep', options: [{ optionName: 'a' }, { optionName: 'b' }] };
        expect((0, baileys_message_mapper_1.extractBaileysPoll)({
            pollCreationMessageV4: { message: { pollCreationMessageV4: { message: { pollCreationMessage: poll } } } },
        })).toBeUndefined();
        expect((0, baileys_message_mapper_1.extractBaileysPoll)({ pollCreationMessageV4: {} })).toBeUndefined();
    });
    it('reports multiple choices and omits unavailable poll data', () => {
        expect((0, baileys_message_mapper_1.extractBaileysPoll)({
            pollCreationMessageV3: {
                name: 'Q',
                options: [{ optionName: 'a' }, { optionName: 'b' }],
                selectableOptionsCount: 0,
            },
        })?.allowMultipleAnswers).toBe(true);
        expect((0, baileys_message_mapper_1.extractBaileysPoll)({})).toBeUndefined();
        expect((0, baileys_message_mapper_1.extractBaileysPoll)({ pollCreationMessage: {} })).toBeUndefined();
    });
    describe.each(shapes)('bounds on %s', (_label, wrap) => {
        const content = (name, optionNames) => wrap({ name, options: optionNames.map(optionName => ({ optionName })), selectableOptionsCount: 1 });
        it('keeps a poll WhatsApp itself could send exactly as it is', () => {
            const question = 'q'.repeat(255);
            const options = Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(100, 'o'));
            expect((0, baileys_message_mapper_1.extractBaileysPoll)(content(question, options))).toEqual({
                name: question,
                options,
                allowMultipleAnswers: false,
            });
            expect((0, baileys_message_mapper_1.extractBaileysBody)(content(question, options))).toBe(question);
        });
        // The numbers are written out here, not read from the constants, so moving either by one shows up.
        it('keeps a poll of 32 options with 1024 characters in each text whole', () => {
            const text = (i) => `${i}`.padEnd(1024, 'x');
            const options = Array.from({ length: 32 }, (_, i) => text(i));
            expect((0, baileys_message_mapper_1.extractBaileysPoll)(content(text(99), options))).toEqual({
                name: text(99),
                options,
                allowMultipleAnswers: false,
            });
            expect((0, baileys_message_mapper_1.extractBaileysBody)(content(text(99), options))).toBe(text(99));
        });
        it('cuts a poll at its 33rd option and at the 1025th character of a text', () => {
            const text = (i) => `${i}`.padEnd(1025, 'x');
            const options = Array.from({ length: 33 }, (_, i) => text(i));
            const poll = (0, baileys_message_mapper_1.extractBaileysPoll)(content(text(99), options));
            expect(poll.options).toEqual(options.slice(0, 32).map(option => option.slice(0, 1024)));
            expect(poll.name).toBe(text(99).slice(0, 1024));
            expect((0, baileys_message_mapper_1.extractBaileysBody)(content(text(99), options))).toBe(text(99).slice(0, 1024));
        });
        it('truncates an oversized poll, in the poll and in the body, and keeps it a poll', () => {
            const long = 'x'.repeat(message_mapper_1.POLL_TEXT_MAX_LENGTH * 3);
            const optionNames = Array.from({ length: message_mapper_1.POLL_MAX_OPTIONS * 50 }, (_, i) => `${i}${long}`);
            const poll = (0, baileys_message_mapper_1.extractBaileysPoll)(content(long, optionNames));
            expect(poll.options).toHaveLength(message_mapper_1.POLL_MAX_OPTIONS);
            expect(poll.options.every(option => option.length === message_mapper_1.POLL_TEXT_MAX_LENGTH)).toBe(true);
            expect(poll.options[1].startsWith('1xxx')).toBe(true);
            expect(poll.name).toHaveLength(message_mapper_1.POLL_TEXT_MAX_LENGTH);
            expect((0, baileys_message_mapper_1.extractBaileysBody)(content(long, optionNames))).toHaveLength(message_mapper_1.POLL_TEXT_MAX_LENGTH);
        });
    });
});
describe('storedKeyInChatPersisted', () => {
    it('accepts an exact identity without requiring a directory', async () => {
        expect(await (0, baileys_message_mapper_1.storedKeyInChatPersisted)({ remoteJid: '111@lid' }, '111@lid')).toBe(true);
        expect(await (0, baileys_message_mapper_1.storedKeyInChatPersisted)({ remoteJid: '628111@s.whatsapp.net' }, '628111@c.us')).toBe(true);
    });
    it('refuses cross-form identity when no directory is available', async () => {
        expect(await (0, baileys_message_mapper_1.storedKeyInChatPersisted)({ remoteJid: '111@lid' }, '628111@c.us')).toBe(false);
        expect(await (0, baileys_message_mapper_1.storedKeyInChatPersisted)({ remoteJid: '628111@s.whatsapp.net' }, '111@lid')).toBe(false);
    });
    it.each([null, '628222', '628111'])('uses only the reported pairing %s in either direction', async (phone) => {
        const resolve = () => Promise.resolve(phone);
        expect(await (0, baileys_message_mapper_1.storedKeyInChatPersisted)({ remoteJid: '111@lid' }, '628111@c.us', resolve)).toBe(phone === '628111');
        expect(await (0, baileys_message_mapper_1.storedKeyInChatPersisted)({ remoteJid: '628111@s.whatsapp.net' }, '111@lid', resolve)).toBe(phone === '628111');
    });
    it('keeps distinct raw LIDs separate even if a directory maps both to one phone', async () => {
        expect(await (0, baileys_message_mapper_1.storedKeyInChatPersisted)({ remoteJid: '111@lid' }, '222@lid', () => Promise.resolve('628111'))).toBe(false);
    });
});
