"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const webhook_delivery_metrics_1 = require("./webhook-delivery-metrics");
describe('webhook-delivery-metrics', () => {
    it('monotonically increments the terminal-failure total', () => {
        const before = (0, webhook_delivery_metrics_1.getWebhookDeliveryFailuresTotal)();
        (0, webhook_delivery_metrics_1.incrementWebhookDeliveryFailures)();
        (0, webhook_delivery_metrics_1.incrementWebhookDeliveryFailures)();
        expect((0, webhook_delivery_metrics_1.getWebhookDeliveryFailuresTotal)()).toBe(before + 2);
    });
    it('never decreases', () => {
        const a = (0, webhook_delivery_metrics_1.getWebhookDeliveryFailuresTotal)();
        (0, webhook_delivery_metrics_1.incrementWebhookDeliveryFailures)();
        const b = (0, webhook_delivery_metrics_1.getWebhookDeliveryFailuresTotal)();
        expect(b).toBeGreaterThan(a);
    });
});
