"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wa_id_1 = require("./wa-id");
describe('wa-id', () => {
    describe('userPart', () => {
        it('strips the domain and the device suffix', () => {
            expect((0, wa_id_1.userPart)('628111@c.us')).toBe('628111');
            expect((0, wa_id_1.userPart)('628111:12@s.whatsapp.net')).toBe('628111');
            expect((0, wa_id_1.userPart)('120363-456@g.us')).toBe('120363-456');
        });
    });
    describe('parseWaId', () => {
        it('classifies each dialect, folding @s.whatsapp.net and @c.us into one user kind', () => {
            expect((0, wa_id_1.parseWaId)('628111@c.us')).toMatchObject({ kind: 'user', userPart: '628111' });
            expect((0, wa_id_1.parseWaId)('628111@s.whatsapp.net')).toMatchObject({ kind: 'user', userPart: '628111' });
            expect((0, wa_id_1.parseWaId)('628111:3@s.whatsapp.net')).toMatchObject({ kind: 'user', userPart: '628111', device: '3' });
            expect((0, wa_id_1.parseWaId)('120-456@g.us')).toMatchObject({ kind: 'group' });
            expect((0, wa_id_1.parseWaId)('111@lid')).toMatchObject({ kind: 'lid', userPart: '111' });
            expect((0, wa_id_1.parseWaId)('status@broadcast')).toMatchObject({ kind: 'status' });
            expect((0, wa_id_1.parseWaId)('abc@newsletter')).toMatchObject({ kind: 'newsletter' });
            expect((0, wa_id_1.parseWaId)('not-a-jid')).toMatchObject({ kind: 'unknown' });
        });
        it('classifies broadcast and lowercases the parsed parts', () => {
            expect((0, wa_id_1.parseWaId)('123@broadcast')).toMatchObject({ kind: 'broadcast', userPart: '123' });
            expect((0, wa_id_1.parseWaId)('ABC@NEWSLETTER')).toMatchObject({ kind: 'newsletter', userPart: 'abc' });
            expect((0, wa_id_1.parseWaId)('AbCd@LID')).toMatchObject({ kind: 'lid', userPart: 'abcd' });
        });
    });
    describe('isChannelJid', () => {
        it('is true only for a @newsletter (channel) JID', () => {
            expect((0, wa_id_1.isChannelJid)('120363401234567890@newsletter')).toBe(true);
            expect((0, wa_id_1.isChannelJid)('ABC@NEWSLETTER')).toBe(true); // case-insensitive
        });
        it('is false for user, group, lid, broadcast and status JIDs (they resolve to a real Chat)', () => {
            expect((0, wa_id_1.isChannelJid)('628111@c.us')).toBe(false);
            expect((0, wa_id_1.isChannelJid)('628111@s.whatsapp.net')).toBe(false);
            expect((0, wa_id_1.isChannelJid)('120-456@g.us')).toBe(false);
            expect((0, wa_id_1.isChannelJid)('111@lid')).toBe(false);
            expect((0, wa_id_1.isChannelJid)('123@broadcast')).toBe(false);
            expect((0, wa_id_1.isChannelJid)('status@broadcast')).toBe(false);
            expect((0, wa_id_1.isChannelJid)('not-a-jid')).toBe(false);
        });
    });
    describe('toNeutralJid', () => {
        it('maps @s.whatsapp.net (and device suffixes) to @c.us, idempotent on @c.us', () => {
            expect((0, wa_id_1.toNeutralJid)('628111@s.whatsapp.net')).toBe('628111@c.us');
            expect((0, wa_id_1.toNeutralJid)('628111:12@s.whatsapp.net')).toBe('628111@c.us');
            expect((0, wa_id_1.toNeutralJid)('628111@c.us')).toBe('628111@c.us');
        });
        it('keeps groups as @g.us and passes status / empty through', () => {
            expect((0, wa_id_1.toNeutralJid)('120-456@g.us')).toBe('120-456@g.us');
            expect((0, wa_id_1.toNeutralJid)('status@broadcast')).toBe('status@broadcast');
            expect((0, wa_id_1.toNeutralJid)('')).toBe('');
        });
        it('resolves a lid to <phone>@c.us when the resolver knows it, else keeps the raw lid', () => {
            const resolve = (jid) => (jid === '111@lid' ? '628999' : null);
            expect((0, wa_id_1.toNeutralJid)('111@lid', resolve)).toBe('628999@c.us');
            expect((0, wa_id_1.toNeutralJid)('222@lid', resolve)).toBe('222@lid'); // unresolved: kept as a privacy id
            expect((0, wa_id_1.toNeutralJid)('111@lid')).toBe('111@lid'); // no resolver supplied
        });
        it('keeps newsletter and broadcast channels in their own dialect', () => {
            expect((0, wa_id_1.toNeutralJid)('120363-abc@newsletter')).toBe('120363-abc@newsletter');
            expect((0, wa_id_1.toNeutralJid)('120363-def@broadcast')).toBe('120363-def@broadcast');
        });
        it('passes an unrecognized format through unchanged', () => {
            expect((0, wa_id_1.toNeutralJid)('weird-thing')).toBe('weird-thing');
        });
    });
    describe('chatKind', () => {
        it.each([
            ['628111@c.us', 'individual'],
            ['628111@s.whatsapp.net', 'individual'],
            ['628111:12@s.whatsapp.net', 'individual'],
            ['4707@lid', 'individual'],
            ['12036@g.us', 'group'],
            ['abc@newsletter', 'channel'],
            ['status@broadcast', 'status'],
            ['12036@broadcast', 'broadcast'],
            ['not-a-jid', 'unknown'],
            ['', 'unknown'],
        ])('classifies %s as %s', (jid, expected) => {
            expect((0, wa_id_1.chatKind)(jid)).toBe(expected);
        });
    });
    describe('isAddressableParticipant', () => {
        it.each([
            ['628123456789', true],
            ['628123456789@c.us', true],
            ['628123456789@s.whatsapp.net', true],
            ['12345678901234567890@lid', true],
            ['628123456789:12@c.us', true],
            ['  628123456789@c.us  ', true],
            ['NOT A USER', false],
            ['', false],
            ['1234', false],
            ['12036@g.us', false],
            ['status@broadcast', false],
            ['abc@newsletter', false],
            ['abc@weird', false],
            // A recognised domain is not enough: the user-part has to look like a WhatsApp id, or the
            // string still reaches the page-side createWid and throws there — the very failure the guard
            // exists to prevent. Reproduced against a live session before this row was added.
            ['NOT A USER@c.us', false],
            ['abc@c.us', false],
            ['abc@s.whatsapp.net', false],
            ['abc@lid', false],
            ['@c.us', false],
            ['x y@c.us', false],
            ['0@c.us', false],
            ['-1@c.us', false],
            ['+628123456789@c.us', false],
        ])('classifies %s as %s', (value, expected) => {
            expect((0, wa_id_1.isAddressableParticipant)(value)).toBe(expected);
        });
    });
    describe('toParticipantWid', () => {
        it('qualifies a bare number to the c.us dialect', () => {
            expect((0, wa_id_1.toParticipantWid)('628123456789')).toBe('628123456789@c.us');
        });
        it('leaves an already-neutral id untouched', () => {
            expect((0, wa_id_1.toParticipantWid)('628123456789@c.us')).toBe('628123456789@c.us');
            expect((0, wa_id_1.toParticipantWid)('12345678901234567890@lid')).toBe('12345678901234567890@lid');
        });
        it.each([
            [' 628123456789:3@C.US ', '628123456789@c.us'],
            ['628123456789@s.whatsapp.net', '628123456789@c.us'],
            ['628123456789@hosted', '628123456789@c.us'],
            ['12345678901234567890:5@LID', '12345678901234567890@lid'],
            ['12345678901234567890@hosted.lid', '12345678901234567890@lid'],
        ])('reduces the accepted variant %s to the neutral id %s, keeping a lid a lid', (value, expected) => {
            // isIndividualWid accepts every one of these, so forwarding the raw string would hand the
            // engine an id the group's participant list is not keyed by.
            expect((0, wa_id_1.isIndividualWid)(value)).toBe(true);
            expect((0, wa_id_1.toParticipantWid)(value)).toBe(expected);
        });
        it.each([['abc@weird'], ['abc'], ['NOT A USER'], ['']])('leaves %s alone rather than minting a nonsense id from it', value => {
            // The old rule was `p.includes('@') ? p : p + '@c.us'`, which turned every un-domained
            // string into one — `abc` became `abc@c.us`, a well-formed id naming nobody. Keying on the
            // bare-number shape instead means only a number is ever qualified. (`abc@weird` alone would
            // NOT show this: the old rule passed it through too, so it discriminates nothing.)
            expect((0, wa_id_1.toParticipantWid)(value)).toBe(value);
        });
    });
    /**
     * WhatsApp issues Meta-hosted dialects of a phone id and a lid, and Baileys decodes them off the
     * wire (`WAJIDDomains.HOSTED` = 128, `HOSTED_LID` = 129). They used to parse as `unknown` here, so
     * an id we had emitted on GET /chats was refused with a 400 when it was handed back to us.
     *
     * They fold into `user` and `lid` rather than becoming kinds of their own, because the user-part
     * names the SAME account: Baileys rewrites `<n>@hosted` to `<n>@s.whatsapp.net` on every inbound
     * message (`cleanMessage`). A separate kind would split one person's history in two.
     */
    describe('Meta-hosted dialects', () => {
        it('folds each hosted dialect into the entity it names', () => {
            expect((0, wa_id_1.parseWaId)('628111@hosted')).toMatchObject({ kind: 'user', userPart: '628111' });
            expect((0, wa_id_1.parseWaId)('4707@hosted.lid')).toMatchObject({ kind: 'lid', userPart: '4707' });
            expect((0, wa_id_1.parseWaId)('628111:3@hosted')).toMatchObject({ kind: 'user', userPart: '628111', device: '3' });
            expect((0, wa_id_1.parseWaId)('ABC@HOSTED.LID')).toMatchObject({ kind: 'lid', userPart: 'abc' });
        });
        it('does not confuse @hosted.lid with @hosted: the domain is the whole suffix', () => {
            // Same user-part, different entity: one is a phone number, the other a privacy id.
            expect((0, wa_id_1.parseWaId)('4707@hosted.lid').kind).toBe('lid');
            expect((0, wa_id_1.parseWaId)('4707@hosted').kind).toBe('user');
        });
        it('accepts them as individuals, which is what the guards refused before', () => {
            expect((0, wa_id_1.isIndividualWid)('628123456789@hosted')).toBe(true);
            expect((0, wa_id_1.isIndividualWid)('12345678901234567890@hosted.lid')).toBe(true);
            expect((0, wa_id_1.isAddressableParticipant)('628123456789@hosted')).toBe(true);
            // The user-part still has to look like an id: the domain alone was never enough.
            expect((0, wa_id_1.isIndividualWid)('NOT A USER@hosted')).toBe(false);
            expect((0, wa_id_1.isIndividualWid)('1234@hosted.lid')).toBe(false);
        });
        it('normalizes to the neutral dialect of the same account, so history stays in one place', () => {
            expect((0, wa_id_1.toNeutralJid)('628111@hosted')).toBe('628111@c.us');
            expect((0, wa_id_1.toNeutralJid)('628111:3@hosted')).toBe('628111@c.us');
            // An unresolved hosted lid keeps the lid dialect, exactly like a plain @lid.
            expect((0, wa_id_1.toNeutralJid)('4707@hosted.lid')).toBe('4707@lid');
            expect((0, wa_id_1.toNeutralJid)('4707@hosted.lid', () => '628111')).toBe('628111@c.us');
        });
        it('surfaces as an individual chat, not unknown', () => {
            expect((0, wa_id_1.chatKind)('628111@hosted')).toBe('individual');
            expect((0, wa_id_1.chatKind)('4707@hosted.lid')).toBe('individual');
        });
    });
});
