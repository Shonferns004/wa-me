"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_int_1 = require("./env-int");
describe('positiveIntFromEnv', () => {
    const KEY = 'OPENWA_TEST_POSITIVE_INT';
    afterEach(() => {
        delete process.env[KEY];
    });
    it('falls back when the variable is unset or empty', () => {
        expect((0, env_int_1.positiveIntFromEnv)(KEY, 7)).toBe(7);
        process.env[KEY] = '';
        expect((0, env_int_1.positiveIntFromEnv)(KEY, 7)).toBe(7);
    });
    it('reads a plain positive integer, 1 included', () => {
        process.env[KEY] = '42';
        expect((0, env_int_1.positiveIntFromEnv)(KEY, 7)).toBe(42);
        process.env[KEY] = '1';
        expect((0, env_int_1.positiveIntFromEnv)(KEY, 7)).toBe(1);
    });
    it.each(['0', '-5', 'abc'])('falls back on %s', raw => {
        process.env[KEY] = raw;
        expect((0, env_int_1.positiveIntFromEnv)(KEY, 7)).toBe(7);
    });
    // Boot validation rejects these before they reach a reader; this pins what the reader itself does.
    it('takes the leading digits of a unit-suffixed or fractional value', () => {
        process.env[KEY] = '50mb';
        expect((0, env_int_1.positiveIntFromEnv)(KEY, 7)).toBe(50);
        process.env[KEY] = '2.9';
        expect((0, env_int_1.positiveIntFromEnv)(KEY, 7)).toBe(2);
    });
});
describe('positiveIntOrDefault', () => {
    it.each([undefined, '', '   ', 'abc', 'NaN', 'Infinity', '0', '-3', '0.5'])('falls back on %p', raw => {
        expect((0, env_int_1.positiveIntOrDefault)(raw, 7)).toBe(7);
    });
    it('reads a positive number, 1 included, and floors a fraction', () => {
        expect((0, env_int_1.positiveIntOrDefault)('42', 7)).toBe(42);
        expect((0, env_int_1.positiveIntOrDefault)('1', 7)).toBe(1);
        expect((0, env_int_1.positiveIntOrDefault)('2.9', 7)).toBe(2);
        expect((0, env_int_1.positiveIntOrDefault)(' 15 ', 7)).toBe(15);
    });
});
