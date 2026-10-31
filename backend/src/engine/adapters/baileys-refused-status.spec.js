"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const boom_1 = require("@hapi/boom");
const baileys_groups_1 = require("./baileys-groups");
const baileys_channels_1 = require("./baileys-channels");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const engine_throttled_error_1 = require("../../common/errors/engine-throttled.error");
/**
 * `refusedStatusCode` decides whether a Baileys failure was a SERVER refusal (map to 403/404) or a
 * transport death (must propagate). Every case here is built with a real `Boom`, because that is
 * what Baileys throws and because the shape is the whole point: Boom's constructor destructures
 * `data = null`, so no Boom ever carries `data === undefined`.
 *
 * The pre-existing fixtures used `Object.assign(new Error(...), { output })` with no `data` at all,
 * which is why a transport death appeared to propagate in tests while a real one did not.
 */
describe('refusedStatusCode', () => {
    it('reads a server refusal from the numeric data assertNodeErrorFree attaches', () => {
        // query() runs assertNodeErrorFree before returning, and it throws `data: +errNode.attrs.code`.
        expect((0, baileys_groups_1.refusedStatusCode)(new boom_1.Boom('forbidden', { data: 403 }))).toBe(403);
        expect((0, baileys_groups_1.refusedStatusCode)(new boom_1.Boom('gone', { data: 410 }))).toBe(410);
    });
    it.each([
        ['Connection Closed', 428],
        ['Timed Out', 408],
    ])('treats a transport death (%s) as unclassified, so it propagates', (message, statusCode) => {
        // A real Boom: no server error node, and `data` defaulted to null by the constructor.
        const err = new boom_1.Boom(message, { statusCode });
        expect(err.data).toBeNull();
        expect((0, baileys_groups_1.refusedStatusCode)(err)).toBeUndefined();
    });
    it('treats an unanswered query as unclassified rather than a 500-coded refusal', () => {
        // extractGroupMetadata(undefined) — `data: result` with result undefined, normalised to null.
        const err = new boom_1.Boom('Invalid group metadata response: missing <group> node', { data: undefined });
        expect((0, baileys_groups_1.refusedStatusCode)(err)).toBeUndefined();
    });
    it('ignores a non-Boom failure entirely', () => {
        expect((0, baileys_groups_1.refusedStatusCode)(new TypeError('Cannot read properties of undefined'))).toBeUndefined();
        expect((0, baileys_groups_1.refusedStatusCode)(undefined)).toBeUndefined();
    });
});
describe('mapServerRefusal', () => {
    it('maps a server refusal to EngineRefusedError', async () => {
        await expect((0, baileys_groups_1.mapServerRefusal)('Setting the group subject', () => Promise.reject(new boom_1.Boom('forbidden', { data: 403 })))).rejects.toBeInstanceOf(engine_refused_error_1.EngineRefusedError);
    });
    it('lets a dead socket through untouched instead of calling it a permissions problem', async () => {
        const connectionClosed = new boom_1.Boom('Connection Closed', { statusCode: 428 });
        await expect((0, baileys_groups_1.mapServerRefusal)('Setting the group subject', () => Promise.reject(connectionClosed))).rejects.toBe(connectionClosed);
    });
    it('maps 404 to the not-found error when the caller supplies one, and only 404', async () => {
        const notFound = () => new Error('no such group');
        const reject = (code) => () => Promise.reject(new boom_1.Boom('refused', { data: code }));
        await expect((0, baileys_groups_1.mapServerRefusal)('Leaving the group', reject(404), undefined, notFound)).rejects.toThrow('no such group');
        await expect((0, baileys_groups_1.mapServerRefusal)('Leaving the group', reject(403), undefined, notFound)).rejects.toBeInstanceOf(engine_refused_error_1.EngineRefusedError);
        await expect((0, baileys_groups_1.mapServerRefusal)('Leaving the group', reject(404))).rejects.toBeInstanceOf(engine_refused_error_1.EngineRefusedError);
    });
    it('lets an unanswered query through untouched', async () => {
        const noAnswer = new boom_1.Boom('Invalid group metadata response: missing <group> node', { data: undefined });
        await expect((0, baileys_groups_1.mapServerRefusal)('Setting the group subject', () => Promise.reject(noAnswer))).rejects.toBe(noAnswer);
    });
    it('answers a rate limit or a server timeout as 503, not a permissions refusal', async () => {
        const graphQl = (code) => new boom_1.Boom('GraphQL server error: rate limited', { statusCode: code, data: { extensions: { error_code: code } } });
        for (const code of [408, 429]) {
            await expect((0, baileys_groups_1.mapServerRefusal)('Adding participants', () => Promise.reject(new boom_1.Boom('rate-overlimit', { data: code })))).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
            await expect((0, baileys_groups_1.mapServerRefusal)('Deleting the channel', () => Promise.reject(graphQl(code)), baileys_channels_1.wmexRefusalCode)).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
        }
    });
    it('marks only a rate limit as throttled, so a pre-charged budget can be given back', async () => {
        const reject = (code) => () => Promise.reject(new boom_1.Boom('refused', { data: code }));
        await expect((0, baileys_groups_1.mapServerRefusal)('Creating the group', reject(429))).rejects.toBeInstanceOf(engine_throttled_error_1.EngineThrottledError);
        // A server timeout leaves the outcome unknown: it stays a plain transport error.
        await expect((0, baileys_groups_1.mapServerRefusal)('Creating the group', reject(408))).rejects.not.toBeInstanceOf(engine_throttled_error_1.EngineThrottledError);
    });
});
