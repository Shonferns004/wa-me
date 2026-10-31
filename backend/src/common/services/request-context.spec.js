"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const request_context_1 = require("./request-context");
describe('request-context', () => {
    it('getRequestId is undefined outside any run scope', () => {
        expect((0, request_context_1.getRequestId)()).toBeUndefined();
    });
    it('getRequestId returns the id inside runWithRequestId', () => {
        (0, request_context_1.runWithRequestId)('req-abc', () => {
            expect((0, request_context_1.getRequestId)()).toBe('req-abc');
        });
    });
    it('getRequestId is undefined again after the run scope exits', () => {
        (0, request_context_1.runWithRequestId)('req-abc', () => {
            // scope active
        });
        expect((0, request_context_1.getRequestId)()).toBeUndefined();
    });
    it('propagates the id into async work awaited inside the scope', async () => {
        await (0, request_context_1.runWithRequestId)('req-abc', async () => {
            await Promise.resolve();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect((0, request_context_1.getRequestId)()).toBe('req-abc');
        });
    });
    it('restores the enclosing scope after a nested run exits', () => {
        (0, request_context_1.runWithRequestId)('outer', () => {
            (0, request_context_1.runWithRequestId)('inner', () => {
                expect((0, request_context_1.getRequestId)()).toBe('inner');
            });
            expect((0, request_context_1.getRequestId)()).toBe('outer');
        });
    });
});
