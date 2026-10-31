"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hook_results_1 = require("./hook-results");
describe('hook result checks', () => {
    it('accepts a message payload only when it carries both a string id and a string chatId', () => {
        expect((0, hook_results_1.isMessagePayload)({ id: 'm', chatId: 'c@c.us' })).toBe(true);
        expect((0, hook_results_1.isMessagePayload)({ id: 'm' })).toBe(false);
        expect((0, hook_results_1.isMessagePayload)({ chatId: 'c@c.us' })).toBe(false);
        expect((0, hook_results_1.isMessagePayload)({ id: 1, chatId: 'c@c.us' })).toBe(false);
        expect((0, hook_results_1.isMessagePayload)({ id: 'm', chatId: 2 })).toBe(false);
        expect((0, hook_results_1.isMessagePayload)(null)).toBe(false);
        expect((0, hook_results_1.isMessagePayload)(['m', 'c'])).toBe(false);
        expect((0, hook_results_1.isMessagePayload)('m')).toBe(false);
    });
    it('accepts a webhook:before result only when it carries an object payload', () => {
        expect((0, hook_results_1.isWebhookBeforeResult)({ payload: { a: 1 } })).toBe(true);
        expect((0, hook_results_1.isWebhookBeforeResult)({ payload: null })).toBe(false);
        expect((0, hook_results_1.isWebhookBeforeResult)({ payload: [1] })).toBe(false);
        expect((0, hook_results_1.isWebhookBeforeResult)({})).toBe(false);
        expect((0, hook_results_1.isWebhookBeforeResult)(null)).toBe(false);
    });
});
