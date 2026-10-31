"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_defaults_util_1 = require("./config-defaults.util");
describe('seedConfigDefaults', () => {
    const schema = {
        type: 'object',
        properties: {
            timezone: { type: 'string', default: 'UTC' },
            cooldownSec: { type: 'number', default: 3600 },
            schedule: { type: 'object', required: true }, // no default — must stay absent
            rules: { type: 'array', default: [{ q: 'hi', a: 'hello' }] },
        },
    };
    it('seeds schema defaults for absent keys only', () => {
        const out = (0, config_defaults_util_1.seedConfigDefaults)(schema, { timezone: 'Asia/Jakarta' });
        expect(out).toEqual({
            timezone: 'Asia/Jakarta', // explicit value wins
            cooldownSec: 3600,
            rules: [{ q: 'hi', a: 'hello' }],
        });
        expect(out).not.toHaveProperty('schedule'); // required-without-default is never invented
    });
    it('returns the input unchanged when nothing is missing (and no schema)', () => {
        const config = { timezone: 'UTC', cooldownSec: 1, rules: [] };
        expect((0, config_defaults_util_1.seedConfigDefaults)(schema, config)).toBe(config);
        expect((0, config_defaults_util_1.seedConfigDefaults)(undefined, config)).toBe(config);
    });
    it('deep-clones object/array defaults so runtime and persisted copies cannot share references', () => {
        const out = (0, config_defaults_util_1.seedConfigDefaults)(schema, {});
        const again = (0, config_defaults_util_1.seedConfigDefaults)(schema, {});
        expect(out.rules).toEqual(again.rules);
        expect(out.rules).not.toBe(again.rules);
        expect(out.rules[0]).not.toBe(again.rules[0]);
    });
    it('null is an explicit value and is not overwritten by the default', () => {
        const out = (0, config_defaults_util_1.seedConfigDefaults)(schema, { timezone: null });
        expect(out.timezone).toBeNull();
    });
});
