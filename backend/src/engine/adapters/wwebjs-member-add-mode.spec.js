"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wwebjs_groups_1 = require("./wwebjs-groups");
const baileys_group_mapper_1 = require("./baileys-group-mapper");
/**
 * Member-add-mode is encoded three different ways across the two engines, and two of them are
 * booleans with OPPOSITE meanings. Reading either as a plain boolean silently inverts the setting —
 * a group left open to everyone while the API reports admins-only, or the reverse. These tests pin
 * each encoding to the neutral value it must produce.
 *
 *  - whatsapp-web.js runtime: WhatsApp's raw strings 'admin_add' / 'all_member_add'
 *    (GroupChat.js:476, and the WA Web group model it reads from).
 *  - whatsapp-web.js types:   `boolean`, documented as "true = only admins can add"
 *    (index.d.ts:885-890) — not what the runtime actually stores, but decoded anyway.
 *  - Baileys:                 `boolean` where TRUE means all_member_add — the OPPOSITE sense
 *    (Socket/groups.js:304).
 */
describe('member-add-mode normalisation across engines', () => {
    describe('whatsapp-web.js', () => {
        it.each([
            ['admin_add', 'admins'],
            ['all_member_add', 'all'],
        ])('decodes the raw WhatsApp string %s to %s', (raw, expected) => {
            expect((0, wwebjs_groups_1.normalizeWwebjsMemberAddMode)(raw)).toBe(expected);
        });
        it.each([
            [true, 'admins'],
            [false, 'all'],
        ])('decodes the documented boolean %s to %s (true = admins-only per index.d.ts)', (raw, expected) => {
            expect((0, wwebjs_groups_1.normalizeWwebjsMemberAddMode)(raw)).toBe(expected);
        });
        it.each([undefined, '', 'something_else'])('reports %p as unknown rather than guessing', raw => {
            expect((0, wwebjs_groups_1.normalizeWwebjsMemberAddMode)(raw)).toBeUndefined();
        });
    });
    describe('Baileys', () => {
        const metadata = (memberAddMode) => ({ id: 'g@g.us', subject: 'G', participants: [], memberAddMode });
        it('decodes true to all — the INVERSE of the whatsapp-web.js boolean', () => {
            expect((0, baileys_group_mapper_1.mapBaileysGroupInfo)(metadata(true)).memberAddMode).toBe('all');
            // Same input value, opposite answer on the other engine. That is the whole hazard.
            expect((0, wwebjs_groups_1.normalizeWwebjsMemberAddMode)(true)).toBe('admins');
        });
        it('decodes false to admins', () => {
            expect((0, baileys_group_mapper_1.mapBaileysGroupInfo)(metadata(false)).memberAddMode).toBe('admins');
        });
        it('leaves the field undefined when the engine did not report it', () => {
            expect((0, baileys_group_mapper_1.mapBaileysGroupInfo)(metadata(undefined)).memberAddMode).toBeUndefined();
        });
    });
});
