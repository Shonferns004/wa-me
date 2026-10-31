"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const handover_gate_1 = require("./handover-gate");
describe('shouldDispatchToPlugin', () => {
    it('dispatches when there is no handover row (bot is default)', () => {
        expect((0, handover_gate_1.shouldDispatchToPlugin)(null, 'faq-bot')).toBe(true);
    });
    it('dispatches while the conversation is bot-handled', () => {
        expect((0, handover_gate_1.shouldDispatchToPlugin)({ pluginId: 'chatwoot-adapter', handoverState: 'bot' }, 'faq-bot')).toBe(true);
    });
    it('silences OTHER bots when the owner has taken over (human)', () => {
        expect((0, handover_gate_1.shouldDispatchToPlugin)({ pluginId: 'chatwoot-adapter', handoverState: 'human' }, 'faq-bot')).toBe(false);
    });
    it('silences OTHER bots when the conversation is closed', () => {
        expect((0, handover_gate_1.shouldDispatchToPlugin)({ pluginId: 'chatwoot-adapter', handoverState: 'closed' }, 'faq-bot')).toBe(false);
    });
    it('exempts the owning plugin so the relay keeps mirroring', () => {
        expect((0, handover_gate_1.shouldDispatchToPlugin)({ pluginId: 'chatwoot-adapter', handoverState: 'human' }, 'chatwoot-adapter')).toBe(true);
    });
});
