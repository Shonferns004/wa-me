"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_validate_controller_1 = require("./auth-validate.controller");
const api_key_entity_1 = require("./entities/api-key.entity");
describe('AuthValidateController', () => {
    const engineFactory = { getCurrentEngine: () => 'baileys' };
    const controller = new auth_validate_controller_1.AuthValidateController(engineFactory);
    const makeKey = (over = {}) => ({ id: 'k1', role: api_key_entity_1.ApiKeyRole.OPERATOR, isActive: true, allowedIps: null, ...over });
    it('reports the guard-validated key as valid, echoing its role and the running engine', () => {
        expect(controller.validate(makeKey({ role: api_key_entity_1.ApiKeyRole.ADMIN }))).toEqual({
            valid: true,
            role: api_key_entity_1.ApiKeyRole.ADMIN,
            engineType: 'baileys',
            scoped: false,
        });
    });
    it('reports a key restricted to selected sessions as scoped', () => {
        // The dashboard gates the unscoped-only stats reads on this, so a scoped admin never sends them.
        expect(controller.validate(makeKey({ role: api_key_entity_1.ApiKeyRole.ADMIN, allowedSessions: ['s1'] }))).toMatchObject({
            valid: true,
            scoped: true,
        });
        expect(controller.validate(makeKey({ allowedSessions: [] }))).toMatchObject({ scoped: false });
    });
    it('reports the engine to an operator key, which cannot read the admin-only infra route', () => {
        // The dashboard needs the engine to gate status compose and the Channels tab for every writer.
        expect(controller.validate(makeKey({ role: api_key_entity_1.ApiKeyRole.OPERATOR }))).toMatchObject({ engineType: 'baileys' });
    });
    it('returns valid:true for an IP-restricted key (no IP-less re-validation false negative)', () => {
        // The global guard already validated this key against the real client IP and attached it.
        // The handler must NOT re-validate without an IP, which previously fail-closed and wrongly
        // reported valid:false for any key carrying an allowedIps restriction.
        const key = makeKey({ allowedIps: ['10.0.0.0/24'] });
        expect(controller.validate(key)).toEqual({ valid: true, role: key.role, engineType: 'baileys', scoped: false });
    });
    it('returns valid:false when no key is attached (defense-in-depth)', () => {
        expect(controller.validate(undefined)).toEqual({ valid: false });
    });
});
