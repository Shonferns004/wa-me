"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const baileys_groups_1 = require("./baileys-groups");
const baileys_query_deadline_1 = require("./baileys-query-deadline");
/**
 * Baileys' query() waits 60 s (defaultQueryTimeoutMs) for an IQ answer and then RESOLVES undefined. Every
 * other group read and write here answers within OpenWA's own budget, which exists to stay under that
 * clock and under session.proxyTimeoutMs (60 s by default); the invite-code read and its revocation
 * have to as well.
 */
describe('Baileys group invite code queries WhatsApp does not answer', () => {
    /** What groupInviteCode / groupRevokeInvite do when the IQ goes unanswered: undefined after 60 s. */
    const unanswered = () => new Promise(resolve => setTimeout(() => resolve(undefined), 60_000));
    function groups(sock) {
        const host = {
            sessionProxyUrl: () => undefined,
            ensureReady: () => undefined,
            getSocket: () => sock,
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            toNeutralJid: (jid) => jid,
            toEngineJid: (jid) => jid,
            normalizedSelfJid: () => '628999@s.whatsapp.net',
            addLidMappings: jest.fn(),
        };
        return new baileys_groups_1.BaileysGroups(host);
    }
    /** Settles `work` against the fake clock and reports how it ended at `atMs`. */
    async function outcomeAt(work, atMs) {
        let outcome = 'still waiting';
        work.then(value => (outcome = value), (error) => (outcome = error));
        await jest.advanceTimersByTimeAsync(atMs);
        return outcome;
    }
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    it.each([
        ['getGroupInviteCode', 'groupInviteCode'],
        ['revokeGroupInviteCode', 'groupRevokeInvite'],
    ])('%s answers 503 once the query budget is spent', async (method, socketCall) => {
        const delegate = groups({ [socketCall]: jest.fn(unanswered) });
        const outcome = await outcomeAt(delegate[method]('120363000000000000@g.us'), baileys_query_deadline_1.BAILEYS_QUERY_BUDGET_MS + 1);
        expect(outcome).toBeInstanceOf(engine_transport_error_1.EngineTransportError);
    });
    it.each([
        ['getGroupInviteCode', 'groupInviteCode'],
        ['revokeGroupInviteCode', 'groupRevokeInvite'],
    ])('%s still returns the code WhatsApp answered within the budget', async (method, socketCall) => {
        const answered = () => new Promise(resolve => setTimeout(() => resolve('AbCdEf123'), 1_000));
        const delegate = groups({ [socketCall]: jest.fn(answered) });
        const outcome = await outcomeAt(delegate[method]('120363000000000000@g.us'), 1_001);
        expect(outcome).toBe('AbCdEf123');
    });
});
