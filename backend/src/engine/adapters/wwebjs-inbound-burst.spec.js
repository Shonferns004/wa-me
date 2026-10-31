"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const inbound_media_cap_1 = require("./inbound-media-cap");
/**
 * The whatsapp-web.js half of the inbound-media burst bound.
 *
 * `baileys-inbound-burst.spec.js` pins the same property on the other engine, where a queue cap
 * equal to the active slots made admission a constant 8 whatever the batch size, so a burst lost
 * the media of everything past the eighth. The whatsapp-web.js adapter carried the identical
 * construction and kept losing media the same way after the Baileys side was repaired.
 *
 * Unbounding the queue is safe here for a reason that does not hold on Baileys: only the DOWNLOAD
 * runs inside the limiter, not the whole message pipeline, and each message awaits its own
 * `capInboundMediaFor`, so a parked download delays that message alone.
 *
 * But removing the cap removes a degradation as well as a defect, and the second test below is the
 * one that matters. A slot is held until its download REALLY settles — deliberately, so an
 * abandoned download cannot let a fresh one exceed the concurrency bound — and a hung page never
 * settles. The rejected-on-full-queue path used to unblock everyone behind it; with no cap and no
 * bound on the wait, a burst behind stuck slots would park forever and those messages would never
 * be emitted at all, which is strictly worse than emitting them without media.
 */
describe('whatsapp-web.js inbound media burst', () => {
    it('gives the inbound limiter an unbounded queue, so a burst parks instead of shedding', () => {
        const source = (0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, 'whatsapp-web-js.adapter.js'), 'utf8');
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
    it('bounds the caller wait, so a message behind permanently stuck slots still resolves', async () => {
        // The real composition: a limiter whose slots never free, and a caller awaiting admission.
        const limiter = new concurrency_limiter_1.ConcurrencyLimiter(1);
        const wedged = new Promise(() => undefined); // a download that never settles
        void limiter.run(() => wedged); // takes the only slot and keeps it
        let admitted = false;
        const boundedReady = limiter.run(() => {
            admitted = true;
            return Promise.resolve({ data: 'QUJD', mimetype: 'image/jpeg' });
        });
        const media = await (0, inbound_media_cap_1.withInboundDownloadTimeout)(boundedReady, 25);
        expect(admitted).toBe(false); // it never got a slot...
        expect(media).toBeNull(); // ...and the caller still unblocked, to emit without media
    });
    it('wraps the caller wait in the timeout rather than only the admitted download', () => {
        // Structural, because the behaviour above is composition-level: the inner race starts once the
        // task is ADMITTED, so it cannot cover the queue wait. Awaiting boundedReady bare is the shape
        // that reintroduces the unbounded wait.
        const source = (0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, 'whatsapp-web-js.adapter.js'), 'utf8');
        expect(source).toMatch(/await\s+(?:\(0,\s*[A-Za-z0-9_$]+\.withInboundDownloadTimeout\)|withInboundDownloadTimeout)\(\s*boundedReady\s*,/);
        expect(source).not.toMatch(/const\s+media\s*=\s*await\s+boundedReady\s*;/);
    });
});
