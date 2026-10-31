"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hook_interfaces_1 = require("./hook.interfaces");
describe('message:persisted hook event', () => {
    it('is a known event', () => {
        expect((0, hook_interfaces_1.isKnownHookEvent)('message:persisted')).toBe(true);
        expect(hook_interfaces_1.KNOWN_HOOK_EVENTS.has('message:persisted')).toBe(true);
    });
});
describe('message:deleted hook event', () => {
    it('is a known event (search providers reconcile dropped rows via it, #906)', () => {
        expect((0, hook_interfaces_1.isKnownHookEvent)('message:deleted')).toBe(true);
        expect(hook_interfaces_1.KNOWN_HOOK_EVENTS.has('message:deleted')).toBe(true);
    });
});
