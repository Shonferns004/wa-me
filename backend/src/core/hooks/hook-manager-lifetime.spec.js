"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hook_manager_service_1 = require("./hook-manager.service");
const sending_gate_1 = require("./sending-gate");
describe('HookManager registration handles and in-flight scopes', () => {
    afterEach(() => jest.restoreAllMocks());
    it('gives registrations made in the same millisecond separate handles', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(1234);
        const manager = new hook_manager_service_1.HookManager();
        const seen = [];
        const first = manager.register('plugin', 'message:received', () => {
            seen.push('first');
            return Promise.resolve({ continue: true });
        });
        const second = manager.register('plugin', 'message:received', () => {
            seen.push('second');
            return Promise.resolve({ continue: true });
        });
        expect(first).not.toBe(second);
        manager.setPriority(second, 1);
        await manager.execute('message:received', {}, { source: 'test' });
        expect(seen).toEqual(['second', 'first']);
        manager.unregister(second);
        seen.length = 0;
        await manager.execute('message:received', {}, { source: 'test' });
        expect(seen).toEqual(['first']);
    });
    it('runs every message:sending handler for a send a finished handler left scheduled', async () => {
        const manager = new hook_manager_service_1.HookManager();
        let release;
        const released = new Promise(resolve => (release = resolve));
        let later;
        const seen = [];
        manager.register('scheduler', 'message:sending', ctx => {
            later ??= released.then(() => (0, sending_gate_1.applySendingGate)(manager, 's1', 'text', { text: 'later' }, 'test'));
            return Promise.resolve({ continue: true, data: ctx.data });
        }, 1);
        manager.register('veto', 'message:sending', ctx => {
            const text = ctx.data.input.text;
            seen.push(text);
            return Promise.resolve({ continue: text !== 'later' });
        }, 2);
        await (0, sending_gate_1.applySendingGate)(manager, 's1', 'text', { text: 'initial' }, 'test');
        const outcome = later.then(() => 'sent', (error) => error.status);
        release();
        expect(await outcome).toBe(400);
        expect(seen).toEqual(['initial', 'later']);
    });
    it('ends an in-flight scope when the call settles, however it ends', async () => {
        const manager = new hook_manager_service_1.HookManager();
        const probes = [];
        const probe = () => {
            probes.push(new Promise(resolve => setImmediate(resolve)).then(() => manager.isInFlight('message:sending')));
        };
        await manager.runInFlight(['message:sending'], () => {
            probe();
            expect(manager.currentInFlight()).toEqual(['message:sending']);
            return Promise.resolve(7);
        });
        await manager
            .runInFlight(['message:sending'], () => {
            probe();
            return Promise.reject(new Error('failed'));
        })
            .catch(() => undefined);
        expect(manager.runInFlight(['message:sending'], () => (probe(), 7))).toBe(7);
        expect(() => manager.runInFlight(['message:sending'], () => {
            probe();
            throw new Error('failed');
        })).toThrow('failed');
        expect(await Promise.all(probes)).toEqual([false, false, false, false]);
        expect(manager.currentInFlight()).toEqual([]);
    });
    it('keeps an enclosing scope in flight for work nested inside it', async () => {
        const manager = new hook_manager_service_1.HookManager();
        const inner = await manager.runInFlight(['message:received'], () => manager.runInFlight(['message:sending'], () => Promise.resolve(manager.currentInFlight().sort())));
        expect(inner).toEqual(['message:received', 'message:sending']);
    });
});
