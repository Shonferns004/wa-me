"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jid_candidates_1 = require("./jid-candidates");
const PHONE = '919999999999';
const LID = '555000111';
const directory = {
    resolveLid: (lid) => (lid === LID ? PHONE : null),
    lidsForPhone: (phone) => (phone === PHONE ? [LID] : []),
};
describe('resolveJidCandidates', () => {
    it('expands a phone into both user dialects and every lid mapped to it', async () => {
        const out = await (0, jid_candidates_1.resolveJidCandidates)(`${PHONE}@c.us`, directory);
        expect(out).toEqual(expect.arrayContaining([`${PHONE}@c.us`, `${PHONE}@s.whatsapp.net`, `${LID}@lid`]));
    });
    it('expands a lid into its phone and never into the same-digits @c.us', async () => {
        const out = await (0, jid_candidates_1.resolveJidCandidates)(`${LID}@lid`, directory);
        expect(out).toContain(`${LID}@lid`);
        expect(out).toContain(`${PHONE}@c.us`);
        expect(out).not.toContain(`${LID}@c.us`);
    });
    it('normalizes lid and group spellings so the guard and the list filter agree', async () => {
        // A `:device` suffix and an upper-case domain must still match the stored neutral form.
        expect(await (0, jid_candidates_1.resolveJidCandidates)('777000111:5@lid', directory)).toEqual(['777000111@lid']);
        expect(await (0, jid_candidates_1.resolveJidCandidates)('555000111@LID', directory)).toContain('555000111@lid');
        expect(await (0, jid_candidates_1.resolveJidCandidates)('123@G.US', directory)).toEqual(['123@g.us']);
    });
    it('fails closed on a group, status or channel id (literal only)', async () => {
        expect(await (0, jid_candidates_1.resolveJidCandidates)('123@g.us', directory)).toEqual(['123@g.us']);
        expect(await (0, jid_candidates_1.resolveJidCandidates)('status@broadcast', directory)).toEqual(['status@broadcast']);
        expect(await (0, jid_candidates_1.resolveJidCandidates)('123@newsletter', directory)).toEqual(['123@newsletter']);
    });
    // An unrecognised domain (a Baileys `@bot` chat, say) is not a phone: minting `@c.us` from its digits
    // would let the chat-scope guard admit an id the list filter refuses, and widen the chat filter.
    it('keeps an id with an unrecognised domain literal', async () => {
        expect(await (0, jid_candidates_1.resolveJidCandidates)(`${PHONE}@bot`, directory)).toEqual([`${PHONE}@bot`]);
    });
    it('qualifies a bare number', async () => {
        const out = await (0, jid_candidates_1.resolveJidCandidates)(PHONE, directory);
        expect(out).toContain(`${PHONE}@c.us`);
        expect(out).toContain(`${LID}@lid`);
    });
    it('works without a directory (dialects only)', async () => {
        expect(await (0, jid_candidates_1.resolveJidCandidates)(`${PHONE}@c.us`)).toEqual([`${PHONE}@c.us`, `${PHONE}@s.whatsapp.net`]);
        expect(await (0, jid_candidates_1.resolveJidCandidates)(`${LID}@lid`)).toEqual([`${LID}@lid`]);
    });
});
