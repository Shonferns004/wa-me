"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const instance_throttler_guard_1 = require("./instance-throttler.guard");
describe('InstanceThrottlerGuard', () => {
    // The per-instance bucket is charged by IngressService after signature verification; this guard
    // keys only on the client IP.
    it('keys on the client IP even when the ingress route params are present', async () => {
        const guard = Object.create(instance_throttler_guard_1.InstanceThrottlerGuard.prototype);
        const tracked = await guard.getTracker({
            params: { pluginId: 'chatwoot', instanceId: 'acct1' },
            ip: '203.0.113.9',
            headers: {},
        });
        expect(tracked).toContain('203.0.113.9');
        expect(tracked).not.toContain('acct1');
    });
    // A blank compose `${KEY:-}` forward must never become a limit of 0: the throttler would then
    // reject the first hit, silently 429ing all inbound webhooks.
    describe('tier resolution from the environment', () => {
        const KEYS = ['INGRESS_INSTANCE_LIMIT', 'INGRESS_INSTANCE_TTL', 'INGRESS_IP_LIMIT'];
        const saved = [];
        beforeEach(() => {
            saved.length = 0;
            for (const k of KEYS)
                saved.push([k, process.env[k]]);
        });
        afterEach(() => {
            for (const [k, v] of saved) {
                if (v === undefined)
                    delete process.env[k];
                else
                    process.env[k] = v;
            }
        });
        const resolveTiers = async () => {
            const guard = Object.create(instance_throttler_guard_1.InstanceThrottlerGuard.prototype);
            // Skip ThrottlerGuard's own onModuleInit (needs the injected storage/options).
            jest.spyOn(Object.getPrototypeOf(instance_throttler_guard_1.InstanceThrottlerGuard.prototype), 'onModuleInit').mockResolvedValue(undefined);
            await guard.onModuleInit();
            return guard.throttlers;
        };
        it.each(['', '   '])('treats a blank value (%p) as unset instead of a limit of 0', async (blank) => {
            process.env.INGRESS_INSTANCE_LIMIT = blank;
            process.env.INGRESS_INSTANCE_TTL = blank;
            process.env.INGRESS_IP_LIMIT = blank;
            expect(await resolveTiers()).toEqual([{ name: 'ingress-ip', limit: 1200, ttl: 60000 }]);
        });
        it('carries only the client-IP tier, sized from the environment', async () => {
            process.env.INGRESS_INSTANCE_LIMIT = '5';
            process.env.INGRESS_INSTANCE_TTL = '1000';
            process.env.INGRESS_IP_LIMIT = '9';
            expect(await resolveTiers()).toEqual([{ name: 'ingress-ip', limit: 9, ttl: 1000 }]);
        });
    });
});
