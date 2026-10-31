"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const webhook_subscribe_util_1 = require("./webhook-subscribe.util");
describe('onWebhookSubscribe hardening', () => {
    const declaredRoutes = new Set(['chatwoot']);
    it('accepts a declared route without a warning', () => {
        const warn = jest.fn();
        const on = (0, webhook_subscribe_util_1.makeOnWebhookSubscribe)({ pluginId: 'p', declaredRoutes, hasPermission: true, warn });
        on('chatwoot');
        on('chatwoot');
        expect(warn).not.toHaveBeenCalled();
    });
    it('warns at most once about undeclared routes so a flood is not a log-flood vector', () => {
        const warn = jest.fn();
        const on = (0, webhook_subscribe_util_1.makeOnWebhookSubscribe)({ pluginId: 'p', declaredRoutes, hasPermission: true, warn });
        on('x');
        on('y');
        on('z');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('undeclared ingress route'), expect.objectContaining({ pluginId: 'p', route: 'x', action: 'sandbox_unknown_ingress_route' }));
    });
    it('silently drops all routes when the manifest lacks webhook:ingress', () => {
        const warn = jest.fn();
        (0, webhook_subscribe_util_1.makeOnWebhookSubscribe)({ pluginId: 'p', declaredRoutes, hasPermission: false, warn })('unknown');
        expect(warn).not.toHaveBeenCalled();
    });
});
