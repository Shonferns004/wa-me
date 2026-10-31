"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const stats_controller_1 = require("./stats.controller");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
// the global stats routes aggregate across EVERY session and carry no scope param, so the
// ApiKeyGuard's allowedSessions fence doesn't apply. They require ADMIN to keep VIEWER/OPERATOR keys
// out, and @RequireUnscopedKey to keep a session-restricted key out: role and session scope are
// independent, so ADMIN alone does not do that. The per-session route is left ungated: it carries
// :sessionId, so the guard already scopes a restricted key to its own sessions.
describe('StatsController access control', () => {
    const reflector = new core_1.Reflector();
    // Opaque-object view of the prototype so the lint unbound-method rule doesn't fire on a
    // metadata-only handler lookup.
    const proto = stats_controller_1.StatsController.prototype;
    it.each(['getOverview', 'getMessageStats'])('global stats route %s requires ADMIN', method => {
        const role = reflector.get(auth_decorators_1.REQUIRED_ROLE_KEY, proto[method]);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.ADMIN);
    });
    it.each(['getOverview', 'getMessageStats'])('global stats route %s requires an unscoped key', method => {
        expect(reflector.get(auth_decorators_1.UNSCOPED_KEY, proto[method])).toBe(true);
    });
    it('per-session stats is not globally ADMIN-gated (scope-enforced by its :sessionId param)', () => {
        const role = reflector.get(auth_decorators_1.REQUIRED_ROLE_KEY, proto.getSessionStats);
        expect(role).toBeUndefined();
    });
});
