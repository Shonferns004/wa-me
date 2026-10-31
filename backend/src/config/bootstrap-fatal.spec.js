"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bootstrap_fatal_1 = require("./bootstrap-fatal");
describe('runBootstrapOrExit', () => {
    const makeDeps = () => {
        const logs = [];
        const exitCalls = [];
        const deps = {
            logger: {
                error: (m, d) => {
                    logs.push([m, d]);
                },
            },
            exit: (code) => {
                exitCalls.push(code);
            },
        };
        return { deps, logs, exitCalls };
    };
    it('logs and exits(1) when bootstrap rejects with a bind failure (EADDRINUSE from listen())', async () => {
        const { deps, logs, exitCalls } = makeDeps();
        const err = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:2785'), {
            code: 'EADDRINUSE',
        });
        const order = [];
        const closeApp = jest.fn(async () => {
            // A macrotask, not a microtask: an exit that does not await the teardown would land first.
            await new Promise(resolve => setImmediate(resolve));
            order.push('close');
        });
        await (0, bootstrap_fatal_1.runBootstrapOrExit)(() => Promise.reject(err), {
            ...deps,
            closeApp,
            exit: code => {
                order.push('exit');
                exitCalls.push(code);
            },
        });
        expect(exitCalls).toEqual([1]);
        expect(logs).toHaveLength(1);
        expect(logs[0][0]).toMatch(/Fatal error during bootstrap/);
        expect(logs[0][1]).toContain('EADDRINUSE'); // err.stack
        // Teardown ran BEFORE the exit so sessions/connections don't outlive the process.
        expect(order).toEqual(['close', 'exit']);
    });
    // A teardown parked on a promise that holds no handle leaves nothing to keep the event loop alive but
    // this timer. If it were unref'd the process would exit 0, a clean exit of a boot that failed.
    it('holds the event loop open with its bound on a teardown that never settles', async () => {
        const { deps, exitCalls } = makeDeps();
        const timers = [];
        const realSetTimeout = global.setTimeout;
        const spy = jest.spyOn(global, 'setTimeout').mockImplementation((...args) => {
            const timer = realSetTimeout(...args);
            timers.push(timer);
            return timer;
        });
        try {
            await (0, bootstrap_fatal_1.runBootstrapOrExit)(() => Promise.reject(new Error('listen EADDRINUSE')), {
                ...deps,
                closeApp: () => new Promise(() => undefined),
                closeTimeoutMs: 20,
            });
        }
        finally {
            spy.mockRestore();
        }
        expect(exitCalls).toEqual([1]);
        expect(timers.length).toBeGreaterThan(0);
        expect(timers.every(timer => timer.hasRef())).toBe(true);
    });
    it('never logs, tears down, or exits on a successful boot', async () => {
        const { deps, logs, exitCalls } = makeDeps();
        const closeApp = jest.fn().mockResolvedValue(undefined);
        await (0, bootstrap_fatal_1.runBootstrapOrExit)(() => Promise.resolve(), { ...deps, closeApp });
        expect(exitCalls).toEqual([]);
        expect(logs).toEqual([]);
        expect(closeApp).not.toHaveBeenCalled();
    });
    it('still exits(1) when the teardown rejects', async () => {
        const { deps, exitCalls } = makeDeps();
        const closeApp = jest.fn().mockRejectedValue(new Error('close wedged'));
        await (0, bootstrap_fatal_1.runBootstrapOrExit)(() => Promise.reject(new Error('boom')), { ...deps, closeApp });
        expect(exitCalls).toEqual([1]);
    });
    it('still exits(1) when the teardown hangs past the bound', async () => {
        const { deps, exitCalls } = makeDeps();
        // Never settles: without the bound the await below would hang until Jest's own timeout.
        const closeApp = jest.fn(() => new Promise(() => { }));
        await (0, bootstrap_fatal_1.runBootstrapOrExit)(() => Promise.reject(new Error('boom')), { ...deps, closeApp, closeTimeoutMs: 5 });
        expect(exitCalls).toEqual([1]);
        expect(closeApp).toHaveBeenCalledTimes(1);
    });
    it('still exits(1) when the logger throws — the exit is the guarantee', async () => {
        const { deps, exitCalls } = makeDeps();
        deps.logger = {
            error: () => {
                throw new Error('logger is down');
            },
        };
        await (0, bootstrap_fatal_1.runBootstrapOrExit)(() => Promise.reject(new Error('boom')), deps);
        expect(exitCalls).toEqual([1]);
    });
    it('stringifies a non-Error rejection without throwing', async () => {
        const { deps, logs, exitCalls } = makeDeps();
        // Deliberately a non-Error rejection: the handler must stringify it and still exit.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        await (0, bootstrap_fatal_1.runBootstrapOrExit)(() => Promise.reject('a bare string'), deps);
        expect(exitCalls).toEqual([1]);
        expect(logs[0][1]).toContain('a bare string');
    });
    it('skips teardown when no closeApp is provided (failure before app creation)', async () => {
        const { deps, logs, exitCalls } = makeDeps();
        await (0, bootstrap_fatal_1.runBootstrapOrExit)(() => Promise.reject(new Error('bad secrets')), deps);
        expect(exitCalls).toEqual([1]);
        expect(logs[0][1]).toContain('bad secrets');
    });
});
