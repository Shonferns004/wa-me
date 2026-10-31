"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chat_scope_1 = require("./chat-scope");
const PHONE = '919999999999';
const LID = '555000111';
const single = {
    resolveLid: (lid) => Promise.resolve(lid === LID ? PHONE : null),
    lidsForPhone: (phone) => Promise.resolve(phone === PHONE ? [LID] : []),
};
const batch = {
    phonesForLids: (lids) => Promise.resolve(Object.fromEntries(lids.map(lid => [lid, lid === LID ? PHONE : null]))),
    lidsForPhones: (phones) => Promise.resolve(Object.fromEntries(phones.map(phone => [phone, phone === PHONE ? [LID] : []]))),
};
describe('chat-scope', () => {
    it('treats NULL/empty as unrestricted', () => {
        expect((0, chat_scope_1.isChatScopeRestricted)(null)).toBe(false);
        expect((0, chat_scope_1.isChatScopeRestricted)([])).toBe(false);
        expect((0, chat_scope_1.buildChatScope)(null)).toBeNull();
        expect((0, chat_scope_1.buildChatScope)([])).toBeNull();
        expect((0, chat_scope_1.chatScopeAllows)(null, '123@g.us')).toBe(true);
    });
    it('admits an allowlisted group and rejects any other', () => {
        const scope = (0, chat_scope_1.buildChatScope)(['123@g.us']);
        expect((0, chat_scope_1.chatScopeAllows)(scope, '123@g.us')).toBe(true);
        expect((0, chat_scope_1.chatScopeAllows)(scope, '999@g.us')).toBe(false);
        // A group entry must not admit a contact, and vice versa.
        expect((0, chat_scope_1.chatScopeAllows)(scope, '123@c.us')).toBe(false);
    });
    it('matches a phone entry against the @lid form through the directory', async () => {
        const scope = (0, chat_scope_1.buildChatScope)([`${PHONE}@c.us`]);
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, `${PHONE}@c.us`, single)).toBe(true);
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, `${PHONE}@s.whatsapp.net`, single)).toBe(true);
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, `${LID}@lid`, single)).toBe(true);
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, '888000222@lid', single)).toBe(false);
    });
    it('does NOT let a phone entry admit the @lid with the same digits', async () => {
        const scope = (0, chat_scope_1.buildChatScope)([`${PHONE}@c.us`]);
        // A lid's digits are not a phone number: `<phone>@lid` is a different entity unless the table
        // maps it, and this lid is not mapped to this phone.
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, `${PHONE}@lid`, single)).toBe(false);
    });
    it('does NOT let a @lid entry admit the same-digits @c.us chat', async () => {
        const scope = (0, chat_scope_1.buildChatScope)([`${LID}@lid`]);
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, `${LID}@lid`, single)).toBe(true);
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, `${LID}@c.us`, single)).toBe(false);
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, `${PHONE}@c.us`, single)).toBe(true);
    });
    it('leaves an unmapped @lid outside the fence', async () => {
        const scope = (0, chat_scope_1.buildChatScope)([`${PHONE}@c.us`]);
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, '777000333@lid', single)).toBe(false);
    });
    it('accepts a bare phone number and matches its canonical chat', async () => {
        const scope = (0, chat_scope_1.buildChatScope)([PHONE]);
        expect((0, chat_scope_1.chatScopeAllows)(scope, `${PHONE}@c.us`)).toBe(true);
        expect((0, chat_scope_1.chatScopeAllows)(scope, `${PHONE}@s.whatsapp.net`)).toBe(true);
        expect(await (0, chat_scope_1.chatIdAllowed)(scope, `${LID}@lid`, single)).toBe(true);
    });
    it('a phone entry does not admit the same-digits @lid in the expanded filter scope either', async () => {
        const scope = await (0, chat_scope_1.buildExpandedChatScope)([`${PHONE}@c.us`], batch);
        expect((0, chat_scope_1.chatScopeAllows)(scope, `${PHONE}@lid`)).toBe(false);
        const rows = [{ id: `${PHONE}@lid` }, { id: `${PHONE}@c.us` }];
        expect((0, chat_scope_1.filterByChatScope)(scope, rows, r => r.id)).toEqual([{ id: `${PHONE}@c.us` }]);
    });
    it('never admits status, channels or broadcast lists', () => {
        const scope = (0, chat_scope_1.buildChatScope)(['123@g.us', `${PHONE}@c.us`]);
        expect((0, chat_scope_1.chatScopeAllows)(scope, 'status@broadcast')).toBe(false);
        expect((0, chat_scope_1.chatScopeAllows)(scope, '123@newsletter')).toBe(false);
        expect((0, chat_scope_1.chatScopeAllows)(scope, '123@broadcast')).toBe(false);
    });
    it('expands the allowlist once for a list filter (batched directory)', async () => {
        const phoneScope = await (0, chat_scope_1.buildExpandedChatScope)([`${PHONE}@c.us`], batch);
        expect((0, chat_scope_1.chatScopeAllows)(phoneScope, `${LID}@lid`)).toBe(true);
        const lidScope = await (0, chat_scope_1.buildExpandedChatScope)([`${LID}@lid`], batch);
        expect((0, chat_scope_1.chatScopeAllows)(lidScope, `${PHONE}@c.us`)).toBe(true);
        // The literal scope is returned unchanged without a directory.
        expect(await (0, chat_scope_1.buildExpandedChatScope)([`${LID}@lid`])).toEqual((0, chat_scope_1.buildChatScope)([`${LID}@lid`]));
    });
    it('drops an item that carries no chat id from a fenced list', () => {
        const scope = (0, chat_scope_1.buildChatScope)([`${PHONE}@c.us`]);
        const items = [{ id: null }, { id: undefined }, { id: `${PHONE}@c.us` }];
        expect((0, chat_scope_1.filterByChatScope)(scope, items, item => item.id)).toEqual([{ id: `${PHONE}@c.us` }]);
    });
    it('expands a mapped lid to both phone dialects in the filter scope', async () => {
        const scope = await (0, chat_scope_1.buildExpandedChatScope)([`${LID}@lid`], batch);
        expect(scope?.allowed.has(`${PHONE}@c.us`)).toBe(true);
        expect(scope?.allowed.has(`${PHONE}@s.whatsapp.net`)).toBe(true);
    });
    it('filters a list to the fenced chats, leaving an unrestricted key untouched', async () => {
        const rows = [{ id: '123@g.us' }, { id: '999@g.us' }, { id: `${PHONE}@c.us` }];
        const scope = await (0, chat_scope_1.buildExpandedChatScope)(['123@g.us'], batch);
        expect((0, chat_scope_1.filterByChatScope)(scope, rows, r => r.id)).toEqual([{ id: '123@g.us' }]);
        expect((0, chat_scope_1.filterByChatScope)(null, rows, r => r.id)).toEqual(rows);
    });
});
describe('normalizeChatAllowList', () => {
    it('qualifies a bare number to @c.us and de-duplicates', () => {
        expect((0, chat_scope_1.normalizeChatAllowList)([PHONE])).toEqual([`${PHONE}@c.us`]);
        expect((0, chat_scope_1.normalizeChatAllowList)([PHONE, `${PHONE}@c.us`])).toEqual([`${PHONE}@c.us`]);
    });
    it('trims, drops empties, and keeps NULL for "unrestricted"', () => {
        expect((0, chat_scope_1.normalizeChatAllowList)([' 123@g.us ', ''])).toEqual(['123@g.us']);
        expect((0, chat_scope_1.normalizeChatAllowList)([])).toBeNull();
        expect((0, chat_scope_1.normalizeChatAllowList)(null)).toBeNull();
    });
});
