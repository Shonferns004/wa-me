"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const baileys_events_1 = require("./baileys-events");
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * A burst of inbound media messages must all keep their media.
 *
 * `handleMessagesUpsert` submits every message in an upsert to the inbound limiter synchronously,
 * so admission is decided before any download finishes. With a queue cap equal to the active slots
 * the ninth message onward was rejected and re-processed with `skipMedia`, losing the file for
 * every message past the eighth — one upsert of 40 lost 32.
 *
 * No spec exercised this path at all, and the one fixture that built a limiter used
 * `new ConcurrencyLimiter(1)`, whose unbounded queue cannot shed at any batch size. The whole suite
 * was green in the presence of the defect, and equally green under a "fix" that removed the
 * concurrency bound instead — so this asserts the bound as well as the outcome.
 */
const CONCURRENCY = 4;
const CONNECTED_AT = 1_700_000_000;
function mediaMessage(index) {
    return {
        key: { id: `m${index}`, remoteJid: '628111@s.whatsapp.net', fromMe: false },
        messageTimestamp: CONNECTED_AT + 60,
        message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 1024 } },
    };
}
/** Drain the microtask queue until every submitted task has settled. */
const settle = async () => {
    for (let i = 0; i < 50; i++)
        await Promise.resolve();
};
describe('BaileysEvents inbound media burst', () => {
    const build = (batch) => {
        const downloaded = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const warns = [];
        const events = new baileys_events_1.BaileysEvents({
            getSocket: () => ({ updateMediaMessage: jest.fn() }),
            getSocketOrNull: () => null,
            logger: { ...(0, logger_service_1.createLogger)('BurstSpec'), warn: (m) => warns.push(m) },
            toNeutralJid: (jid) => jid,
            normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
            connectedAt: CONNECTED_AT,
            // The production wiring, not a test-only limiter — the point of this spec.
            inboundLimiter: new concurrency_limiter_1.ConcurrencyLimiter(CONCURRENCY),
            recordKeyLidMappings: () => undefined,
            recordMessage: () => undefined,
            recordMessageEdit: () => undefined,
            putStoredMessage: () => undefined,
            getOnMessage: () => undefined,
            getOnMessageCreate: () => undefined,
            getOnMessageRevoked: () => undefined,
            getOnMessageEdited: () => undefined,
            getOnMessageReaction: () => undefined,
            getOnMessageAck: () => undefined,
            getOnMessageReceipt: () => undefined,
            getOnGroupEvent: () => undefined,
            getOnCall: () => undefined,
            getOnPresenceUpdate: () => undefined,
            getOnCallOutcome: () => undefined,
        });
        // Stand in for the download: records that media was fetched, and tracks concurrency while it runs.
        events.processInboundMessage = async (msg, opts) => {
            if (opts?.skipMedia)
                return;
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            downloaded.push(msg.key?.id ?? '?');
            inFlight--;
        };
        const messages = Array.from({ length: batch }, (_, i) => mediaMessage(i + 1));
        return { events, messages, downloaded, warns, peak: () => maxInFlight };
    };
    it.each([12, 40])('keeps the media of every message in a batch of %i', async (batch) => {
        const h = build(batch);
        h.events.handleMessagesUpsert({ messages: h.messages, type: 'notify' });
        await settle();
        expect(h.downloaded.length).toBe(batch);
        expect(h.warns).toEqual([]);
    });
    it('never exceeds the configured concurrency while doing so', async () => {
        const h = build(40);
        h.events.handleMessagesUpsert({ messages: h.messages, type: 'notify' });
        await settle();
        // Guard the guard: a peak of 0 would mean nothing ran and the assertion above is vacuous.
        expect(h.peak()).toBeGreaterThan(0);
        // Removing the bound instead of the queue cap also makes the test above pass. This is what
        // separates the two.
        expect(h.peak()).toBeLessThanOrEqual(CONCURRENCY);
    });
    // Two different failures reach the rejection handler and they are not the same event. Reporting a
    // failed download as "limiter saturated" sends an operator to look at concurrency settings for a
    // problem that was never there.
    it.each([
        ['ConcurrencyLimiter closed', 'closed during teardown'],
        ['socket hung up', 'download failed'],
    ])('says which failure happened when a submission rejects with "%s"', async (message, expected) => {
        const h = build(1);
        h.events.processInboundMessage = (_msg, opts) => (opts?.skipMedia ? Promise.resolve() : Promise.reject(new Error(message)));
        h.events.handleMessagesUpsert({ messages: h.messages, type: 'notify' });
        await settle();
        expect(h.warns).toHaveLength(1);
        expect(h.warns[0]).toContain(expected);
    });
    // The tests above build their own limiter, so they cannot see how the adapter builds its one.
    // This is the assertion that actually guards production: re-adding the queue cap is the
    // regression, and it is a second constructor argument.
    it('builds the adapter limiter without a queue cap', () => {
        const source = (0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, 'baileys.adapter.js'), 'utf8');
        const construction = source.match(/new (?:[A-Za-z0-9_$]+\.)?ConcurrencyLimiter\(([\s\S]*?)\);/);
        // Guard the parser: a renamed limiter would make this vacuous.
        expect(construction).not.toBeNull();
        const raw = (construction?.[1] ?? '').replace(/\/\/[^\n]*/g, '');
        const args = [];
        let depth = 0;
        let current = '';
        for (const ch of raw) {
            if (ch === '(' || ch === '[' || ch === '{')
                depth += 1;
            else if (ch === ')' || ch === ']' || ch === '}')
                depth -= 1;
            if (ch === ',' && depth === 0) {
                args.push(current.trim());
                current = '';
                continue;
            }
            current += ch;
        }
        if (current.trim())
            args.push(current.trim());
        const normalized = args.map(arg => arg.replace(/\(0,\s*[A-Za-z0-9_$]+\.([A-Za-z0-9_$]+)\)/g, '$1').replace(/\s+/g, ''));
        expect(normalized).toEqual(['inboundMediaConcurrency()']);
    });
});
