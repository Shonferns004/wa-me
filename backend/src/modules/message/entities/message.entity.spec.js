"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const message_entity_1 = require("./message.entity");
// bigint columns read back as a string on PostgreSQL but a number on SQLite; the transformer
// normalizes reads so the REST/SDK/MCP contract (always `number`) holds on both dialects.
describe('bigintToNumberTransformer (message.timestamp)', () => {
    it('coerces a PostgreSQL bigint string read to a number', () => {
        // ValueTransformer.from is typed `any`, so assert inline rather than binding to an `any` local.
        expect(message_entity_1.bigintToNumberTransformer.from('1700000000')).toBe(1700000000);
        expect(typeof message_entity_1.bigintToNumberTransformer.from('1700000000')).toBe('number');
    });
    it('passes a SQLite numeric read through unchanged', () => {
        expect(message_entity_1.bigintToNumberTransformer.from(1700000000)).toBe(1700000000);
    });
    it('preserves null', () => {
        expect(message_entity_1.bigintToNumberTransformer.from(null)).toBeNull();
    });
    it('writes values through unchanged', () => {
        expect(message_entity_1.bigintToNumberTransformer.to(1700000000)).toBe(1700000000);
        expect(message_entity_1.bigintToNumberTransformer.to(null)).toBeNull();
    });
    it('coerces a non-numeric read to null rather than leaking NaN (defensive)', () => {
        // A bigint column cannot actually return this; the guard keeps NaN out of the number contract.
        expect(message_entity_1.bigintToNumberTransformer.from('not-a-number')).toBeNull();
    });
});
