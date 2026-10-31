"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("@nestjs/common/constants");
const core_1 = require("@nestjs/core");
const plugins_controller_1 = require("./plugins.controller");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
describe('PluginsController authorization', () => {
    const reflector = new core_1.Reflector();
    // Plugin reads expose installed versions, non-secret config, and health/error text — privileged
    // inventory on par with the ADMIN-gated write routes and the infra controllers' convention. A
    // VIEWER/OPERATOR key (or a session-scoped key) must not be able to enumerate it via the raw API.
    // Install, update and uninstall run third-party code on the host.
    const adminOnly = [
        'findAll',
        'install',
        'installFromUrl',
        'catalog',
        'findOne',
        'healthCheck',
        'enable',
        'disable',
        'updateConfig',
        'getConfigUi',
        'updateSessionConfig',
        'updateSessions',
        'update',
        'uninstall',
    ];
    it('lists every route handler, so a new route cannot skip the role check', () => {
        const proto = plugins_controller_1.PluginsController.prototype;
        const routes = Object.getOwnPropertyNames(proto).filter(name => name !== 'constructor' && Reflect.getMetadata(constants_1.PATH_METADATA, proto[name]) !== undefined);
        expect([...routes].sort()).toEqual([...adminOnly].sort());
    });
    it.each(adminOnly)('%s requires the ADMIN role', method => {
        // Metadata lookup key, never invoked.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const handler = plugins_controller_1.PluginsController.prototype[method];
        const role = reflector.get(auth_decorators_1.REQUIRED_ROLE_KEY, handler);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.ADMIN);
    });
    it('updateSessions requires an unrestricted key because updateSessions replaces the complete active set', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const handler = plugins_controller_1.PluginsController.prototype.updateSessions;
        expect(reflector.get(auth_decorators_1.UNSCOPED_KEY, handler)).toBe(true);
    });
});
describe('PluginsController.install() OpenAPI responses', () => {
    it('declares the 413 the upload size limit returns', () => {
        const responses = Reflect.getMetadata('swagger/apiResponse', Object.getOwnPropertyDescriptor(plugins_controller_1.PluginsController.prototype, 'install').value);
        expect(Object.keys(responses)).toContain('413');
    });
    // The global ValidationPipe refuses an invalid body, or one carrying an undeclared field, with a 400.
    it.each(['updateConfig', 'updateSessionConfig', 'updateSessions'])('declares the validation 400 on %s', handler => {
        const responses = (Reflect.getMetadata('swagger/apiResponse', Object.getOwnPropertyDescriptor(plugins_controller_1.PluginsController.prototype, handler).value) ?? {});
        expect(responses['400']?.description).toMatch(/validation/i);
    });
});
