"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hooks_1 = require("../hooks");
const plugin_capability_context_1 = require("./plugin-capability-context");
const plugin_interfaces_1 = require("./plugin.interfaces");
const logger_service_1 = require("../../common/services/logger.service");
describe('the logger a plugin gets', () => {
    const manifest = {
        id: 'p1',
        name: 'P1',
        version: '1.0.0',
        type: plugin_interfaces_1.PluginType.EXTENSION,
        main: 'index.js',
    };
    const setup = (sink) => {
        const host = { error: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };
        const context = new plugin_capability_context_1.PluginCapabilityContext(sink ?? host, {}, new hooks_1.HookManager(), { createPluginStorage: () => ({}) });
        const plugin = {
            manifest,
            status: plugin_interfaces_1.PluginStatus.ENABLED,
            config: {},
            sessionConfig: {},
        };
        return { host, logger: context.createPluginContext(plugin).logger };
    };
    it('passes no trace when an error line has no error, so the line does not carry the text "undefined"', () => {
        const { host, logger } = setup();
        logger.error('upload failed');
        logger.error('upload failed', undefined, { sessionId: 's1' });
        expect(host.error).toHaveBeenNthCalledWith(1, '[p1] upload failed', undefined, {}, { pluginId: 'p1' });
        expect(host.error).toHaveBeenNthCalledWith(2, '[p1] upload failed', undefined, { sessionId: 's1' }, { pluginId: 'p1' });
    });
    // The parameter is a record, but plugin code is not type checked: a string or an array given as the meta must not be
    // spread into one field per character or per index.
    describe('a meta that is not a record', () => {
        // The fields a host logger call writes: the meta (the second argument, or the third of error()) and the host's own
        // fields, which follow it.
        const metaOf = (spy, argument) => {
            const [meta, own] = spy.mock.calls[0].slice(argument);
            return { ...meta, ...own };
        };
        const asRecord = (meta) => meta;
        it.each([
            ['a string', 'abc'],
            ['an array', [1, { token: 't' }]],
            ['a number', 404],
        ])('writes %s as one field', (_name, meta) => {
            const { host, logger } = setup();
            logger.log('m', asRecord(meta));
            logger.debug('m', asRecord(meta));
            logger.warn('m', asRecord(meta));
            logger.error('m', undefined, asRecord(meta));
            for (const written of [metaOf(host.log, 1), metaOf(host.debug, 1), metaOf(host.warn, 1), metaOf(host.error, 2)]) {
                expect(written).toEqual({ meta, pluginId: 'p1' });
            }
        });
        it.each([
            ['undefined', undefined],
            ['null', null],
        ])('writes %s as no fields besides the plugin id', (_name, meta) => {
            const { host, logger } = setup();
            logger.warn('m', asRecord(meta));
            expect(host.warn).toHaveBeenCalledWith('[p1] m', {}, { pluginId: 'p1' });
            expect(Object.keys(metaOf(host.warn, 1))).toEqual(['pluginId']);
        });
        it('writes a string as one field of the line the logger prints', () => {
            logger_service_1.LoggerService.setLogFormat(logger_service_1.LogFormat.JSON);
            const warn = jest.spyOn(console, 'warn').mockImplementation();
            try {
                const { logger } = setup((0, logger_service_1.createLogger)('Plugins'));
                logger.warn('failed', 'abc');
                const line = JSON.parse(warn.mock.calls[0][0]);
                expect(line).toMatchObject({ message: '[p1] failed', meta: 'abc', pluginId: 'p1' });
                expect(line).not.toHaveProperty('0');
            }
            finally {
                warn.mockRestore();
                logger_service_1.LoggerService.setLogFormat(null);
            }
        });
        // Only a plain record is spread into the fields of the line; every other object is one value.
        it.each([
            ['a String wrapper', () => new String('hello')],
            ['a Uint8Array', () => new Uint8Array([1, 2, 3])],
            ['a Map', () => new Map([[1, 2]])],
            ['a Date', () => new Date(0)],
            ['an Error', () => new Error('boom')],
            ['an instance of a class', () => new (class Model {
                })()],
        ])('writes %s as one field', (_name, make) => {
            const { host, logger } = setup();
            const meta = make();
            logger.warn('m', asRecord(meta));
            expect(host.warn).toHaveBeenCalledWith('[p1] m', { meta }, { pluginId: 'p1' });
            expect(Object.keys(metaOf(host.warn, 1))).toEqual(['meta', 'pluginId']);
        });
        it.each([
            ['an object literal', () => ({ sessionId: 's1' })],
            [
                'an object without a prototype',
                () => Object.assign(Object.create(null), { sessionId: 's1' }),
            ],
            ['a record made in another realm', () => structuredClone({ sessionId: 's1' })],
        ])('keeps %s as the fields of the line', (_name, make) => {
            const { host, logger } = setup();
            logger.warn('m', asRecord(make()));
            expect(metaOf(host.warn, 1)).toEqual({ sessionId: 's1', pluginId: 'p1' });
        });
        it('keeps the fields of a record as they are', () => {
            const { host, logger } = setup();
            logger.warn('m', { sessionId: 's1', nested: { a: 1 } });
            expect(host.warn).toHaveBeenCalledWith('[p1] m', { sessionId: 's1', nested: { a: 1 } }, { pluginId: 'p1' });
        });
    });
    // The plugin id is the host's field, not part of the plugin's meta: a meta the logger cuts or cannot read keeps it.
    describe('a meta the logger cannot write whole', () => {
        const wide = () => {
            const meta = {};
            for (let key = 0; key <= 2_000_000; key++)
                meta[`k${key}`] = 1;
            return meta;
        };
        const throwing = () => ({
            a: {
                get b() {
                    throw new Error('getter');
                },
            },
        });
        it.each([
            ['a value below it throws when read', throwing, 'metadata', '[Unreadable]'],
            ['it has more keys than one line may copy', wide, 'metadata', '[Truncated]'],
            [
                'a key name passes the characters one line may write',
                () => ({ a: 'x'.repeat(2 ** 26 - 5), bbbbbbbbbb: 1 }),
                'metadata',
                '[Truncated]',
            ],
            [
                'its strings take every character one line may write',
                () => ({ big: 'x'.repeat(2 ** 26) }),
                'big',
                '[Truncated]',
            ],
        ])('keeps the plugin id when %s', (_name, make, field, marker) => {
            logger_service_1.LoggerService.setLogFormat(logger_service_1.LogFormat.JSON);
            const warn = jest.spyOn(console, 'warn').mockImplementation();
            const error = jest.spyOn(console, 'error').mockImplementation();
            try {
                const { logger } = setup((0, logger_service_1.createLogger)('Plugins'));
                logger.warn('failed', make());
                logger.error('failed', new Error('boom'), make());
                for (const spy of [warn, error]) {
                    const line = JSON.parse(spy.mock.calls[0][0]);
                    expect(line).toMatchObject({ message: '[p1] failed', [field]: marker, pluginId: 'p1' });
                }
                expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ trace: 'boom' });
            }
            finally {
                warn.mockRestore();
                error.mockRestore();
                logger_service_1.LoggerService.setLogFormat(null);
            }
        });
        it('writes the host plugin id where a pluginId of the meta stood, never the meta one', () => {
            logger_service_1.LoggerService.setLogFormat(logger_service_1.LogFormat.JSON);
            const warn = jest.spyOn(console, 'warn').mockImplementation();
            try {
                const { logger } = setup((0, logger_service_1.createLogger)('Plugins'));
                logger.warn('m', { pluginId: 'other', a: 1 });
                expect(warn.mock.calls[0][0]).toContain('"message":"[p1] m","pluginId":"p1","a":1}');
            }
            finally {
                warn.mockRestore();
                logger_service_1.LoggerService.setLogFormat(null);
            }
        });
    });
    // Plugin code is not type checked and can pass anything: no argument may make the call throw into the plugin, and
    // every line keeps the plugin id.
    describe('an argument that throws when it is read', () => {
        const trap = () => {
            throw new Error('trap');
        };
        const revoked = (target) => {
            const { proxy, revoke } = Proxy.revocable(target, {});
            revoke();
            return proxy;
        };
        // The lines of the nine calls below, in the order they were made, whatever console method each went to.
        const written = (make) => {
            logger_service_1.LoggerService.setLogFormat(logger_service_1.LogFormat.JSON);
            logger_service_1.LoggerService.setLogLevel(logger_service_1.LogLevel.DEBUG);
            const lines = [];
            const spies = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
            for (const spy of spies)
                spy.mockImplementation((line) => lines.push(JSON.parse(line)));
            try {
                const { logger } = setup((0, logger_service_1.createLogger)('Plugins'));
                const meta = () => make();
                logger.log(make());
                logger.debug(make());
                logger.warn(make());
                logger.error(make());
                logger.error('m', make());
                logger.log('m', meta());
                logger.debug('m', meta());
                logger.warn('m', meta());
                logger.error('m', undefined, meta());
                return lines;
            }
            finally {
                for (const spy of spies)
                    spy.mockRestore();
                logger_service_1.LoggerService.setLogFormat(null);
                logger_service_1.LoggerService.setLogLevel(logger_service_1.LogLevel.INFO);
            }
        };
        it.each([
            ['a Proxy whose getPrototypeOf trap throws', () => new Proxy({ a: 1 }, { getPrototypeOf: trap })],
            ['a Proxy whose get trap throws', () => new Proxy({ a: 1 }, { get: trap })],
            ['a Proxy whose ownKeys trap throws', () => new Proxy({ a: 1 }, { ownKeys: trap })],
            ['a revoked Proxy', () => revoked({ a: 1 })],
            ['a revoked Proxy of an array', () => revoked([1])],
            ['an object whose toString throws', () => ({ toString: trap, valueOf: trap })],
            ['an object without a prototype', () => Object.create(null)],
            ['a Symbol', () => Symbol('s')],
            [
                'an Error whose message getter throws',
                () => Object.defineProperty(new Error('x'), 'message', { get: trap }),
            ],
            [
                'an Error behind a Proxy whose getPrototypeOf trap throws',
                () => new Proxy(new Error('x'), { getPrototypeOf: trap }),
            ],
        ])('writes every line with the plugin id when the message, error or meta is %s', (_name, make) => {
            const all = written(make);
            expect(all).toHaveLength(9);
            for (const line of all)
                expect(line).toMatchObject({ pluginId: 'p1' });
        });
        it('writes what it can read: the text String gives, the marker for the rest, a Proxy meta by its own properties', () => {
            expect(written(() => Symbol('s'))[0]).toMatchObject({ message: '[p1] Symbol(s)' });
            expect(written(() => Object.create(null))[0]).toMatchObject({ message: '[p1] [Unprintable]' });
            const message = Object.defineProperty(new Error('x'), 'message', { get: trap });
            expect(written(() => message)[4]).toMatchObject({ message: '[p1] m', trace: '[Unprintable]' });
            expect(written(() => new Proxy({ a: 1 }, { getPrototypeOf: trap }))[5]).toMatchObject({ a: 1, pluginId: 'p1' });
            expect(written(() => revoked({ a: 1 }))[5]).toMatchObject({ metadata: '[Unreadable]', pluginId: 'p1' });
        });
    });
    it('passes the message of an Error, and the text of anything else, as the trace', () => {
        const { host, logger } = setup();
        logger.error('upload failed', new Error('boom'));
        logger.error('upload failed', 'plain text');
        logger.error('upload failed', 404);
        logger.error('upload failed', null);
        expect(host.error.mock.calls.map((call) => call[1])).toEqual(['boom', 'plain text', '404', 'null']);
    });
});
