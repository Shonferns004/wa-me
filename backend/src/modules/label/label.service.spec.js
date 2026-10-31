"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const label_service_1 = require("./label.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
describe('LabelService', () => {
    const makeService = (engine) => {
        const engines = new engine_registry_service_1.EngineRegistry();
        if (engine)
            engines.set('s1', engine);
        return new label_service_1.LabelService(engines);
    };
    it('throws 400 when the session is not started', () => {
        expect(() => makeService(undefined).getLabels('s1')).toThrow(common_1.BadRequestException);
    });
    it('maps a missing label to 404', async () => {
        const svc = makeService({ getLabelById: jest.fn().mockResolvedValue(null) });
        await expect(svc.getLabelById('s1', 'l404')).rejects.toBeInstanceOf(common_1.NotFoundException);
    });
    it('delegates addLabelToChat to the engine', async () => {
        const addLabelToChat = jest.fn().mockResolvedValue(undefined);
        await makeService({ addLabelToChat }).addLabelToChat('s1', 'chat1', 'l1');
        expect(addLabelToChat).toHaveBeenCalledWith('chat1', 'l1');
    });
    it('delegates getLabels to the engine and returns its list', async () => {
        const labels = [{ id: 'l1', name: 'VIP' }];
        const getLabels = jest.fn().mockResolvedValue(labels);
        await expect(makeService({ getLabels }).getLabels('s1')).resolves.toBe(labels);
        expect(getLabels).toHaveBeenCalledTimes(1);
    });
    it('delegates getLabelById and returns the label when it exists', async () => {
        const label = { id: 'l1', name: 'VIP' };
        const getLabelById = jest.fn().mockResolvedValue(label);
        await expect(makeService({ getLabelById }).getLabelById('s1', 'l1')).resolves.toBe(label);
        expect(getLabelById).toHaveBeenCalledWith('l1');
    });
    // Only a null lookup maps to 404 — an engine failure says nothing about whether the label
    // exists, so it must propagate unchanged rather than be reported as "not found".
    it('propagates an engine failure from getLabelById instead of mapping it to 404', async () => {
        const down = new Error('engine down');
        const getLabelById = jest.fn().mockRejectedValue(down);
        await expect(makeService({ getLabelById }).getLabelById('s1', 'l1')).rejects.toBe(down);
    });
    it('delegates getChatLabels to the engine', async () => {
        const getChatLabels = jest.fn().mockResolvedValue([{ id: 'l1' }]);
        await expect(makeService({ getChatLabels }).getChatLabels('s1', 'c@c.us')).resolves.toEqual([{ id: 'l1' }]);
        expect(getChatLabels).toHaveBeenCalledWith('c@c.us');
    });
    it('delegates removeLabelFromChat to the engine', async () => {
        const removeLabelFromChat = jest.fn().mockResolvedValue(undefined);
        await makeService({ removeLabelFromChat }).removeLabelFromChat('s1', 'chat1', 'l1');
        expect(removeLabelFromChat).toHaveBeenCalledWith('chat1', 'l1');
    });
    it('throws 400 for getChatLabels and removeLabelFromChat when the session is not started', () => {
        const svc = makeService(undefined);
        expect(() => svc.getChatLabels('s1', 'c@c.us')).toThrow(common_1.BadRequestException);
        expect(() => svc.removeLabelFromChat('s1', 'chat1', 'l1')).toThrow(common_1.BadRequestException);
    });
    // Every label operation is a pass-through: a rejecting engine must reach the caller as-is.
    it.each([
        ['getLabels', { getLabels: jest.fn() }, (svc) => svc.getLabels('s1')],
        ['getChatLabels', { getChatLabels: jest.fn() }, (svc) => svc.getChatLabels('s1', 'c@c.us')],
        ['upsertLabel', { upsertLabel: jest.fn() }, (svc) => svc.upsertLabel('s1', 'l1', { name: 'VIP' })],
        ['deleteLabel', { deleteLabel: jest.fn() }, (svc) => svc.deleteLabel('s1', 'l1')],
        ['getChatsByLabel', { getChatsByLabel: jest.fn() }, (svc) => svc.getChatsByLabel('s1', 'l1')],
        ['addLabelToChat', { addLabelToChat: jest.fn() }, (svc) => svc.addLabelToChat('s1', 'chat1', 'l1')],
        [
            'removeLabelFromChat',
            { removeLabelFromChat: jest.fn() },
            (svc) => svc.removeLabelFromChat('s1', 'chat1', 'l1'),
        ],
    ])('propagates an engine failure from %s unchanged', async (_name, engine, call) => {
        const down = new Error('engine down');
        const method = Object.values(engine)[0];
        method.mockRejectedValue(down);
        await expect(call(makeService(engine))).rejects.toBe(down);
    });
});
// Create and update are one operation upstream — a single `label_edit` write keyed on the label id —
// so the service must not invent two, and must not send fields the caller did not set.
describe('LabelService label editing', () => {
    const makeService = (engine) => {
        const engines = new engine_registry_service_1.EngineRegistry();
        engines.set('s1', engine);
        return new label_service_1.LabelService(engines);
    };
    it('refuses an empty body — nothing to write, and an unused id would create a nameless label', () => {
        const upsertLabel = jest.fn();
        expect(() => makeService({ upsertLabel }).upsertLabel('s1', 'l1', {})).toThrow(common_1.BadRequestException);
        expect(upsertLabel).not.toHaveBeenCalled();
    });
    it('sends the path id as the label id', async () => {
        const upsertLabel = jest.fn().mockResolvedValue(undefined);
        await makeService({ upsertLabel }).upsertLabel('s1', 'l1', { name: 'VIP' });
        expect(upsertLabel).toHaveBeenCalledWith({ id: 'l1', name: 'VIP' });
    });
    // Omitted fields must stay omitted rather than becoming undefined-valued keys. The service sends
    // only the fields the caller set, and the adapter forwards them unchanged; the write replaces the
    // whole label. Compared with toStrictEqual: toHaveBeenCalledWith treats `name: undefined` as absent,
    // which is the very shape this test exists to refuse.
    it('passes through only the fields the caller set', async () => {
        const upsertLabel = jest.fn().mockResolvedValue(undefined);
        const svc = makeService({ upsertLabel });
        await svc.upsertLabel('s1', 'l1', { color: 3 });
        await svc.upsertLabel('s1', 'l2', { name: 'VIP' });
        expect(upsertLabel.mock.calls.map(call => call[0])).toStrictEqual([
            { id: 'l1', color: 3 },
            { id: 'l2', name: 'VIP' },
        ]);
    });
    it('refuses a body whose only fields are null, as it refuses an empty one', () => {
        const upsertLabel = jest.fn();
        const svc = makeService({ upsertLabel });
        for (const body of [{ name: null }, { color: null }, { name: null, color: null }]) {
            expect(() => svc.upsertLabel('s1', 'l1', body)).toThrow('At least one of name or color must be provided');
        }
        expect(upsertLabel).not.toHaveBeenCalled();
    });
    it('drops a null field instead of forwarding it to the engine', async () => {
        const upsertLabel = jest.fn().mockResolvedValue(undefined);
        const svc = makeService({ upsertLabel });
        await svc.upsertLabel('s1', 'l1', { name: null, color: 3 });
        await svc.upsertLabel('s1', 'l2', { name: 'VIP', color: null });
        expect(upsertLabel.mock.calls.map(call => call[0])).toStrictEqual([
            { id: 'l1', color: 3 },
            { id: 'l2', name: 'VIP' },
        ]);
    });
    it('delegates deleteLabel to the engine', async () => {
        const deleteLabel = jest.fn().mockResolvedValue(undefined);
        await makeService({ deleteLabel }).deleteLabel('s1', 'l1');
        expect(deleteLabel).toHaveBeenCalledWith('l1');
    });
    it('delegates getChatsByLabel to the engine', async () => {
        const getChatsByLabel = jest.fn().mockResolvedValue([{ id: 'c@c.us' }]);
        await expect(makeService({ getChatsByLabel }).getChatsByLabel('s1', 'l1')).resolves.toEqual([{ id: 'c@c.us' }]);
        expect(getChatsByLabel).toHaveBeenCalledWith('l1');
    });
    it.each([
        ['upsertLabel', (svc) => svc.upsertLabel('s1', 'l1', { name: 'VIP' })],
        ['deleteLabel', (svc) => svc.deleteLabel('s1', 'l1')],
        ['getChatsByLabel', (svc) => svc.getChatsByLabel('s1', 'l1')],
    ])('throws 400 for %s when the session is not started', (_name, call) => {
        const engines = new engine_registry_service_1.EngineRegistry();
        expect(() => call(new label_service_1.LabelService(engines))).toThrow(common_1.BadRequestException);
        expect(() => call(new label_service_1.LabelService(engines))).toThrow('Session is not started');
    });
});
