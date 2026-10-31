"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const filter_validation_1 = require("./filter-validation");
const filter_types_1 = require("./filter-types");
describe('collectFilterErrors (message-type enum)', () => {
    const typeCondition = (...types) => ({
        conditions: [{ field: 'type', operator: 'is', value: types }],
    });
    it('accepts every neutral message type, including poll', () => {
        // `poll` was offered by the dashboard's type picker while validation refused it, so a saved
        // filter could never round-trip. The list must cover the whole neutral union.
        expect((0, filter_validation_1.collectFilterErrors)(typeCondition('poll'))).toEqual([]);
        expect((0, filter_validation_1.collectFilterErrors)(typeCondition(...filter_types_1.MESSAGE_TYPES))).toEqual([]);
    });
    it('still rejects a type outside the neutral union', () => {
        expect((0, filter_validation_1.collectFilterErrors)(typeCondition('banana'))).toEqual(['conditions[0].value "banana" is not a valid type']);
    });
});
describe('collectFilterErrors (empty conditions)', () => {
    it('accepts an empty conditions list, which the published contract documents as "no filter"', () => {
        // A client that cannot send `filters: null` (the Java SDK omits null fields) clears a filter
        // with `{ conditions: [] }`, so this must stay valid.
        expect((0, filter_validation_1.collectFilterErrors)({ conditions: [] })).toEqual([]);
    });
});
describe('collectFilterErrors (unknown keys)', () => {
    const condition = { field: 'type', operator: 'is', value: ['text'] };
    it('rejects a key beside conditions, which evaluation would ignore', () => {
        expect((0, filter_validation_1.collectFilterErrors)({ conditions: [condition], match: 'any' })).toEqual([
            'filters has unknown key(s): match',
        ]);
    });
    it('rejects a condition key evaluation would ignore', () => {
        expect((0, filter_validation_1.collectFilterErrors)({ conditions: [{ ...condition, negate: true }] })).toEqual([
            'conditions[0] has unknown key(s): negate',
        ]);
    });
    it('accepts every key a condition declares', () => {
        const text = { field: 'body', operator: 'contains', value: 'hi', caseSensitive: true };
        expect((0, filter_validation_1.collectFilterErrors)({ conditions: [condition, text] })).toEqual([]);
    });
});
