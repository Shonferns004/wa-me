"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const config_1 = require("@nestjs/config");
const settings_controller_1 = require("./settings.controller");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
// ConfigService stub: return the supplied default for every key.
const configStub = {
    get: (_key, def) => def,
};
describe('SettingsController', () => {
    it('GET /settings returns the environment-derived settings', () => {
        const settings = new settings_controller_1.SettingsController(configStub).get();
        expect(settings).toHaveProperty('general');
        expect(settings.general).not.toHaveProperty('sessionTimeout');
        expect(settings).toHaveProperty('api');
        expect(settings).toHaveProperty('notifications');
    });
    it('reads the rate limit, debug flag and port from the keys the app configures', () => {
        const prev = process.env.BASE_URL;
        try {
            delete process.env.BASE_URL;
            const config = new config_1.ConfigService({
                port: 9999,
                database: { logging: true },
                api: { rateLimit: { mediumLimit: 7, mediumTtl: 1234 } },
            });
            const settings = new settings_controller_1.SettingsController(config).get();
            expect(settings.api.rateLimit).toBe(7);
            expect(settings.api.rateLimitWindow).toBe(1234);
            expect(settings.general.debugMode).toBe(true);
            expect(settings.general.apiBaseUrl).toBe('http://localhost:9999');
        }
        finally {
            if (prev !== undefined)
                process.env.BASE_URL = prev;
        }
    });
    it('reports no notification feature as enabled, since none exists', () => {
        expect(new settings_controller_1.SettingsController(configStub).get().notifications).toEqual({
            emailEnabled: false,
            notificationEmail: '',
            webhookAlerts: false,
        });
    });
    it('reports enableDocs from the real ENABLE_SWAGGER gate, not a hardcoded true', () => {
        const prev = process.env.ENABLE_SWAGGER;
        try {
            process.env.ENABLE_SWAGGER = 'false';
            expect(new settings_controller_1.SettingsController(configStub).get().api.enableDocs).toBe(false);
            process.env.ENABLE_SWAGGER = 'true';
            expect(new settings_controller_1.SettingsController(configStub).get().api.enableDocs).toBe(true);
        }
        finally {
            if (prev === undefined)
                delete process.env.ENABLE_SWAGGER;
            else
                process.env.ENABLE_SWAGGER = prev;
        }
    });
    it('reports apiBaseUrl from BASE_URL when the operator configured one', () => {
        const prev = process.env.BASE_URL;
        try {
            process.env.BASE_URL = 'https://wa.example.com';
            expect(new settings_controller_1.SettingsController(configStub).get().general.apiBaseUrl).toBe('https://wa.example.com');
        }
        finally {
            if (prev === undefined)
                delete process.env.BASE_URL;
            else
                process.env.BASE_URL = prev;
        }
    });
    it('GET /settings requires the ADMIN role (env-derived config is not for low-privilege keys)', () => {
        const proto = settings_controller_1.SettingsController.prototype;
        const role = new core_1.Reflector().get(auth_decorators_1.REQUIRED_ROLE_KEY, proto.get);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.ADMIN);
    });
});
