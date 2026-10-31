"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const message_projector_service_1 = require("./message-projector.service");
const status = {
    id: 'st1',
    chatId: 'status@broadcast',
    from: 'status@broadcast',
    to: '620000@c.us',
    author: '628111@c.us',
    fromMe: false,
    isStatusBroadcast: true,
    body: 'hi',
    type: 'text',
    timestamp: 1_700_000_000,
    isGroup: false,
    kind: 'status',
};
describe('status.received for a status that was ingested', () => {
    const run = async (expiresAt, created = true) => {
        const engines = new engine_registry_service_1.EngineRegistry();
        const engine = {};
        engines.set('s1', engine);
        const dispatch = jest.fn().mockResolvedValue(undefined);
        const emitStatusReceived = jest.fn();
        const row = { waStatusId: 'st1', contactJid: '628111@c.us', type: 'text', mediaOmitted: false, expiresAt };
        const projector = new message_projector_service_1.MessageProjector({}, {}, engines, { emitStatusReceived }, { dispatch }, {}, { ingest: jest.fn().mockResolvedValue({ row: row, created }) }, {});
        await projector.handleInboundMessage('s1', engine, status)?.settled;
        return { dispatch, emitStatusReceived };
    };
    it('announces a status that is still live', async () => {
        const { dispatch, emitStatusReceived } = await run(Date.now() + 60_000);
        expect(dispatch).toHaveBeenCalledWith('s1', 'status.received', expect.objectContaining({ statusId: 'st1' }));
        expect(emitStatusReceived).toHaveBeenCalledTimes(1);
    });
    it('announces nothing for a status that expired while it was being ingested', async () => {
        const { dispatch, emitStatusReceived } = await run(Date.now() - 1);
        expect(dispatch).not.toHaveBeenCalled();
        expect(emitStatusReceived).not.toHaveBeenCalled();
    });
    it('announces nothing for a status that was already stored', async () => {
        const { dispatch } = await run(Date.now() + 60_000, false);
        expect(dispatch).not.toHaveBeenCalled();
    });
});
