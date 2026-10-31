"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const date_transformer_1 = require("./date.transformer");
// DateTransformer.to() resolves the DATA connection dialect from the global DATABASE_TYPE.
// Characterization tests lock the round-trip behavior (previously untested).
describe('DateTransformer (cross-DB date round-trip)', () => {
    const original = process.env.DATABASE_TYPE;
    afterEach(() => {
        if (original === undefined)
            delete process.env.DATABASE_TYPE;
        else
            process.env.DATABASE_TYPE = original;
    });
    it('from(): parses ISO strings to Date, passes a Date through, maps null to null', () => {
        const parsed = date_transformer_1.DateTransformer.from('2026-06-20T10:00:00.000Z');
        expect(parsed).toBeInstanceOf(Date);
        expect(parsed.toISOString()).toBe('2026-06-20T10:00:00.000Z');
        const now = new Date();
        expect(date_transformer_1.DateTransformer.from(now)).toBe(now);
        expect(date_transformer_1.DateTransformer.from(null)).toBeNull();
    });
    it('to(): stores an ISO string on SQLite and a native Date on Postgres; null stays null', () => {
        const d = new Date('2026-06-20T10:00:00.000Z');
        process.env.DATABASE_TYPE = 'sqlite';
        expect(date_transformer_1.DateTransformer.to(d)).toBe('2026-06-20T10:00:00.000Z');
        process.env.DATABASE_TYPE = 'postgres';
        expect(date_transformer_1.DateTransformer.to(d)).toBe(d);
        expect(date_transformer_1.DateTransformer.to(null)).toBeNull();
    });
});
