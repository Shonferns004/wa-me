"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const integration_instance_controller_1 = require("./integration-instance.controller");
// A config PATCH of an instance whose plugin is not loaded answers 409. The published contract of the
// route is built from its @ApiResponse metadata, so the status the route answers must be listed there.
describe('PATCH /integration/plugins/:pluginId/instances/:instanceId documents its 409', () => {
    it('answers 409 for a config write while the plugin is not loaded, and publishes that status', async () => {
        const update = jest.fn();
        const instances = {
            resolve: jest.fn().mockResolvedValue({
                id: 'chatwoot-adapter:acct1',
                pluginId: 'chatwoot-adapter',
                instanceId: 'acct1',
                sessionScope: 'sess-1',
                secret: 's',
                verifyToken: null,
                config: {},
                enabled: true,
            }),
            update,
        };
        const loader = { getPlugin: jest.fn().mockReturnValue(undefined) };
        const controller = new integration_instance_controller_1.IntegrationInstanceController(instances, loader, { logInfo: jest.fn() }, { applyScopeBinding: jest.fn() });
        await expect(controller.patch('chatwoot-adapter', 'acct1', { enabled: false, config: { baseUrl: 'https://x' } })).rejects.toThrow(common_1.ConflictException);
        // Nothing of the body is written, `enabled` included.
        expect(update).not.toHaveBeenCalled();
        const handler = Object.getOwnPropertyDescriptor(integration_instance_controller_1.IntegrationInstanceController.prototype, 'patch')?.value;
        const responses = Reflect.getMetadata(swagger_1.DECORATORS.API_RESPONSE, handler);
        expect(Object.keys(responses)).toContain('409');
    });
});
