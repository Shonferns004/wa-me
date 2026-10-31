"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const chat_scope_service_1 = require("./chat-scope.service");
const typeorm_1 = require("typeorm");
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const lid_mapping_entity_1 = require("../../engine/identity/lid-mapping.entity");
const session_entity_1 = require("../session/entities/session.entity");
const PHONE = '919999999999';
const LID = '555000111';
/** Deterministic persisted-lookup stand-in; the real service reads the lid table on a cache miss. */
function fakeStore() {
    return {
        findPhoneForLid: jest.fn((lid) => Promise.resolve(lid === LID ? PHONE : null)),
        findLidsForPhone: jest.fn((phone) => Promise.resolve(phone === PHONE ? [LID] : [])),
        phonesForLidsPersisted: jest.fn((lids) => Promise.resolve(Object.fromEntries(lids.map(lid => [lid, lid === LID ? PHONE : null])))),
        lidsForPhonesPersisted: jest.fn((phones) => Promise.resolve(Object.fromEntries(phones.map(phone => [phone, phone === PHONE ? [LID] : []])))),
    };
}
describe('ChatScopeService', () => {
    it('requireChat refuses a restricted key that names no chat, and nothing else', () => {
        const svc = new chat_scope_service_1.ChatScopeService();
        const restricted = { allowedChats: ['1@c.us'] };
        for (const chatId of [undefined, '', '   ']) {
            expect(() => svc.requireChat(restricted, chatId)).toThrow(common_1.ForbiddenException);
        }
        expect(() => svc.requireChat(restricted, '1@c.us')).not.toThrow();
        expect(() => svc.requireChat({ allowedChats: null }, undefined)).not.toThrow();
        expect(() => svc.requireChat(undefined, undefined)).not.toThrow();
    });
    it('is unrestricted without an allowlist', async () => {
        const svc = new chat_scope_service_1.ChatScopeService();
        expect(svc.isRestricted({ allowedChats: null })).toBe(false);
        expect(svc.isRestricted({ allowedChats: [] })).toBe(false);
        expect(svc.scopeFor({ allowedChats: null })).toBeNull();
        expect(await svc.allows({ allowedChats: null }, '123@g.us')).toBe(true);
    });
    it('matches a phone entry to its lid through the persisted directory', async () => {
        const svc = new chat_scope_service_1.ChatScopeService(fakeStore());
        expect(svc.isRestricted({ allowedChats: [`${PHONE}@c.us`] })).toBe(true);
        expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${LID}@lid`)).toBe(true);
        expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, '888000222@lid')).toBe(false);
    });
    it('does not admit the same-digits @c.us for a @lid entry', async () => {
        const svc = new chat_scope_service_1.ChatScopeService(fakeStore());
        expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${LID}@c.us`)).toBe(false);
        expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${LID}@lid`)).toBe(true);
        expect(await svc.allows({ allowedChats: [`${LID}@lid`] }, `${PHONE}@c.us`)).toBe(true);
    });
    it('candidatesFor expands a phone and a lid through the directory, and always keeps the id as given', async () => {
        const svc = new chat_scope_service_1.ChatScopeService(fakeStore());
        const phone = await svc.candidatesFor(`${PHONE}@c.us`);
        expect(phone).toEqual(expect.arrayContaining([`${PHONE}@c.us`, `${PHONE}@s.whatsapp.net`, `${LID}@lid`]));
        const lid = await svc.candidatesFor(`${LID}@lid`);
        expect(lid).toEqual(expect.arrayContaining([`${LID}@lid`, `${PHONE}@c.us`]));
        // A spelling the expansion does not fold still names the rows stored under it.
        for (const spelling of ['120363@G.US', '120363@g.us ', '999@LID', '999:7@lid']) {
            expect(await svc.candidatesFor(spelling)).toContain(spelling);
        }
        expect(new Set(phone).size).toBe(phone.length);
    });
    it('filters a list through the batched expansion, passing an unrestricted key through', async () => {
        const svc = new chat_scope_service_1.ChatScopeService(fakeStore());
        const rows = [{ id: '123@g.us' }, { id: `${LID}@lid` }, { id: '999@g.us' }];
        expect(await svc.filter({ allowedChats: [`${PHONE}@c.us`] }, rows, r => r.id)).toEqual([{ id: `${LID}@lid` }]);
        expect(await svc.filter({ allowedChats: null }, rows, r => r.id)).toEqual(rows);
    });
    it('idsForFilter returns the expanded id array, or undefined when unrestricted', async () => {
        const svc = new chat_scope_service_1.ChatScopeService(fakeStore());
        const ids = await svc.idsForFilter({ allowedChats: [`${PHONE}@c.us`, '120@g.us'] });
        expect(ids).toEqual(expect.arrayContaining([`${PHONE}@c.us`, `${PHONE}@s.whatsapp.net`, `${LID}@lid`, '120@g.us']));
        expect(await svc.idsForFilter({ allowedChats: null })).toBeUndefined();
        expect(await svc.idsForFilter({ allowedChats: [] })).toBeUndefined();
        expect(await svc.idsForFilter({ allowedChats: ['not-a-chat'] })).toEqual([]);
        expect(await svc.idsForFilter(undefined)).toBeUndefined();
    });
    it('follows a lid another node has re-mapped, in the single check and the list filter alike', async () => {
        const rows = [{ lid: LID, phone: PHONE, isReported: true }];
        const hit = (value, cond) => cond === undefined || (cond instanceof typeorm_1.FindOperator ? cond.value.includes(value) : value === cond);
        const repo = {
            find: jest.fn((o) => Promise.resolve(rows.filter(r => hit(r.lid, o?.where?.lid) && hit(r.phone, o?.where?.phone)))),
            findOne: jest.fn((o) => Promise.resolve(rows.find(r => r.lid === o.where.lid) ?? null)),
        };
        const store = new lid_mapping_store_service_1.LidMappingStoreService(repo);
        await store.onModuleInit(); // the cache now indexes LID -> PHONE
        rows[0].phone = '918888888888'; // another node re-mapped the lid in the shared table
        const svc = new chat_scope_service_1.ChatScopeService(store);
        // The table is the truth across nodes: the lid now answers the new phone only, on both paths.
        const lidKey = { allowedChats: [`${LID}@lid`] };
        expect(await svc.allows(lidKey, `${PHONE}@c.us`)).toBe(false);
        expect(await svc.allows(lidKey, '918888888888@c.us')).toBe(true);
        const lidScope = (await svc.scopeForFilter(lidKey));
        expect([lidScope.allowed.has(`${PHONE}@c.us`), lidScope.allowed.has('918888888888@c.us')]).toEqual([false, true]);
        for (const [phone, admitted] of [
            [PHONE, false],
            ['918888888888', true],
        ]) {
            const key = { allowedChats: [`${phone}@c.us`] };
            expect(await svc.allows(key, `${LID}@lid`)).toBe(admitted);
            expect((await svc.scopeForFilter(key)).allowed.has(`${LID}@lid`)).toBe(admitted);
        }
    });
    it('degrades to exact dialects when no lid directory is available', async () => {
        const svc = new chat_scope_service_1.ChatScopeService();
        expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${LID}@lid`)).toBe(false);
        expect(await svc.allows({ allowedChats: [`${PHONE}@c.us`] }, `${PHONE}@c.us`)).toBe(true);
    });
});
describe('ChatScopeService over the shared lid table, with two sessions', () => {
    const key = { allowedChats: [`${PHONE}@c.us`] };
    const [s1, s2] = ['00000001-0000-4000-8000-000000000000', '00000002-0000-4000-8000-000000000000'];
    let ds;
    let store;
    let svc;
    let warn;
    const admitted = async () => [
        await svc.allows(key, `${LID}@lid`),
        (await svc.scopeForFilter(key)).allowed.has(`${LID}@lid`),
    ];
    beforeEach(async () => {
        ds = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [lid_mapping_entity_1.LidMapping, session_entity_1.Session],
            synchronize: true,
        }).initialize();
        await ds.getRepository(session_entity_1.Session).insert([s1, s2].map(id => ({ id, name: id, phone: `6290000000${id[7]}` })));
        store = new lid_mapping_store_service_1.LidMappingStoreService(ds.getRepository(lid_mapping_entity_1.LidMapping));
        // A statement that fails is only logged, which would let a case pass on a write that never ran.
        warn = jest.spyOn(store.logger, 'warn');
        await store.onModuleInit();
        svc = new chat_scope_service_1.ChatScopeService(store);
        await store.remember(LID, PHONE, s1);
    });
    afterEach(async () => {
        expect(warn).not.toHaveBeenCalled();
        await ds.destroy();
    });
    it('still admits the lid of a phone after a session that cannot see the number answers no phone', async () => {
        expect(await admitted()).toEqual([true, true]);
        await store.remember(LID, null, s2);
        expect(await admitted()).toEqual([true, true]);
    });
    it('still admits it after the session that stored the phone answers no phone, when another one reported it since', async () => {
        await store.remember(LID, PHONE, s2);
        await store.remember(LID, null, s1);
        expect(await admitted()).toEqual([true, true]);
    });
    it('stops admitting it once the session that stored the phone answers no phone', async () => {
        await store.remember(LID, null, s1);
        expect(await admitted()).toEqual([false, false]);
    });
    it('still admits it after the latest session to report the phone is deleted, once an earlier one reports it again', async () => {
        const s3 = '00000003-0000-4000-8000-000000000000';
        await ds.getRepository(session_entity_1.Session).insert({ id: s3, name: s3, phone: '629000000003' });
        await store.remember(LID, PHONE, s2);
        await ds.getRepository(session_entity_1.Session).delete({ id: s2 });
        await store.releaseSession(s2);
        await store.remember(LID, PHONE, s1);
        await store.remember(LID, null, s3);
        expect(await admitted()).toEqual([true, true]);
    });
    it('admits it for the phone another node has since stored, on both paths', async () => {
        const other = new lid_mapping_store_service_1.LidMappingStoreService(ds.getRepository(lid_mapping_entity_1.LidMapping)); // a second node on the same table
        await other.onModuleInit();
        await other.remember(LID, '628222', s2);
        expect(await admitted()).toEqual([false, false]);
        const newKey = { allowedChats: ['628222@c.us'] };
        expect([
            await svc.allows(newKey, `${LID}@lid`),
            (await svc.scopeForFilter(newKey)).allowed.has(`${LID}@lid`),
        ]).toEqual([true, true]);
    });
    it('admits it for neither phone while a phone write of this node has not reached the table', async () => {
        const newKey = { allowedChats: ['628222@c.us'] };
        const admittedNew = async () => [
            await svc.allows(newKey, `${LID}@lid`),
            (await svc.scopeForFilter(newKey)).allowed.has(`${LID}@lid`),
        ];
        jest.spyOn(ds.getRepository(lid_mapping_entity_1.LidMapping), 'upsert').mockRejectedValueOnce(new Error('connection lost'));
        await store.remember(LID, '628222', s1);
        warn.mockClear();
        expect([await admitted(), await admittedNew()]).toEqual([
            [false, false],
            [false, false],
        ]);
        await store.remember(LID, '628222', s1); // the write lands
        expect([await admitted(), await admittedNew()]).toEqual([
            [false, false],
            [true, true],
        ]);
    });
    it('stops admitting it once the session that stored the phone logs out and another answers no phone', async () => {
        await ds.getRepository(session_entity_1.Session).update({ id: s1 }, { phone: null });
        await store.remember(LID, null, s2);
        expect(await admitted()).toEqual([false, false]);
    });
    it('stops admitting it once the session that stored the phone is deleted and another answers no phone', async () => {
        await ds.getRepository(session_entity_1.Session).delete({ id: s1 });
        await store.remember(LID, null, s2);
        expect(await admitted()).toEqual([false, false]);
    });
});
