"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationInstanceController = void 0;
const common_1 = require("@nestjs/common");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
const audit_service_1 = require("../audit/audit.service");
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const plugin_activation_1 = require("../../core/plugins/plugin-activation");
const plugin_instance_service_1 = require("./plugin-instance.service");
const scope_binding_service_1 = require("./scope-binding.service");
const ingress_url_1 = require("./ingress-url");
const instance_dto_1 = require("./dto/instance.dto");
const session_scope_1 = require("../../common/security/session-scope");
const swagger_1 = require("@nestjs/swagger");
// A session-restricted key narrows nothing outside its own sessions: binding or releasing its instance
// must not retire the plugin's all-sessions activation, which an unrestricted operator set.
const isScopedKey = (apiKey) => (apiKey?.allowedSessions?.length ?? 0) > 0;
/**
 * What the instance has put into the plugin's base config: its config while it is enabled on the wildcard
 * scope, nothing otherwise. That merged config is where a secret the instance stops contributing would stay
 * behind (see ScopeBindingService.applyScopeBinding), and an instance that was not contributing, being
 * disabled or on one session, left nothing there to take back.
 */
const contributedConfig = (inst) => inst.enabled && (0, plugin_activation_1.isAllSessionsScope)(inst.sessionScope) ? (inst.config ?? undefined) : undefined;
// ADMIN-only provisioning surface for per-plugin instances (e.g. one Chatwoot account). Only plugins
// that declare an ingress route AND the webhook:ingress permission can have instances; everything
// else is rejected before touching persistence.
let IntegrationInstanceController = class IntegrationInstanceController {
    instances;
    loader;
    audit;
    scopeBinding;
    constructor(instances, loader, audit, scopeBinding) {
        this.instances = instances;
        this.loader = loader;
        this.audit = audit;
        this.scopeBinding = scopeBinding;
    }
    async create(pluginId, dto, apiKey) {
        const routes = this.assertIngressCapable(pluginId);
        this.assertScopeWritable(apiKey, dto.sessionScope);
        try {
            const inst = await this.instances.create(pluginId, dto.instanceId, {
                sessionScope: dto.sessionScope,
                verifyToken: dto.verifyToken,
                secret: dto.secret,
                config: dto.config,
            });
            void this.audit.logInfo(audit_log_entity_1.AuditAction.INTEGRATION_INSTANCE_CREATED, {
                metadata: { pluginId, instanceId: dto.instanceId },
            });
            await this.scopeBinding.applyScopeBinding(pluginId, inst.sessionScope, inst.config ?? {}, inst.enabled, {
                additive: isScopedKey(apiKey),
            });
            return this.view(inst, routes, /* reveal */ true);
        }
        catch (err) {
            if (err instanceof plugin_instance_service_1.InstanceExistsError)
                throw new common_1.ConflictException(err.message);
            throw err;
        }
    }
    async list(pluginId, apiKey) {
        const routes = this.pluginRoutes(pluginId);
        const rows = await this.instances.list(pluginId);
        return rows
            .filter(r => (0, session_scope_1.sessionScopeVisible)(apiKey?.allowedSessions, r.sessionScope))
            .map(r => this.view(r, routes, false));
    }
    async getOne(pluginId, instanceId, apiKey) {
        const inst = await this.resolveVisible(pluginId, instanceId, apiKey);
        return this.view(inst, this.pluginRoutes(pluginId), false);
    }
    async regenerate(pluginId, instanceId, apiKey) {
        await this.resolveVisible(pluginId, instanceId, apiKey);
        const inst = await this.instances.regenerateSecret(pluginId, instanceId);
        // regenerateSecret() answers null when the row was deleted after resolveVisible read it.
        if (!inst)
            throw new common_1.NotFoundException('instance not found');
        void this.audit.logInfo(audit_log_entity_1.AuditAction.INTEGRATION_INSTANCE_SECRET_REGENERATED, {
            metadata: { pluginId, instanceId },
        });
        return this.view(inst, this.pluginRoutes(pluginId), true);
    }
    async patch(pluginId, instanceId, dto, apiKey) {
        let inst = await this.resolveVisible(pluginId, instanceId, apiKey);
        if (dto.sessionScope !== undefined)
            this.assertScopeWritable(apiKey, dto.sessionScope);
        const previousScope = inst.sessionScope;
        const previousConfig = contributedConfig(inst);
        // One update() writes every field in a single save. Restoring the masked config can refuse the
        // PATCH with a 400 before that save, so a rejected body changes nothing, `enabled` included.
        if (dto.enabled !== undefined || dto.sessionScope !== undefined || dto.config !== undefined) {
            const plugin = this.loader.getPlugin(pluginId);
            // An instance row outlives its plugin. Without the manifest there are no host keys to tell a moved host
            // from an unchanged one, and echoing the mask would put every stored secret back beside whatever host
            // the body names, so a config write waits for the plugin to be loaded.
            if (dto.config && !plugin) {
                throw new common_1.ConflictException(`Plugin ${pluginId} is not loaded, so its instance config cannot be changed`);
            }
            inst = await this.instances.update(pluginId, instanceId, { enabled: dto.enabled, sessionScope: dto.sessionScope, config: dto.config }, this.schemaFor(pluginId), { net: plugin?.manifest.net, beneath: plugin?.config });
            // update() answers null when the row was deleted after resolveVisible read it.
            if (!inst)
                throw new common_1.NotFoundException('instance not found');
        }
        const updated = inst;
        // If the bound session changed, tear down the OLD scope (incl. a wildcard/null scope) so it stops
        // firing with stale config. The new scope is (re)bound right after; teardown runs first with the new
        // scope already persisted, so the wildcard retirement check sees the current state correctly.
        if (previousScope !== updated.sessionScope) {
            // A move between the spellings of the wildcard scope is re-bound right below: retracting here would
            // only hand the running plugin a config without its secrets for the length of one call.
            await this.scopeBinding.applyScopeBinding(pluginId, previousScope, {}, false, {
                previousConfig: (0, plugin_activation_1.isAllSessionsScope)(updated.sessionScope) ? undefined : previousConfig,
                additive: isScopedKey(apiKey),
            });
        }
        await this.scopeBinding.applyScopeBinding(pluginId, updated.sessionScope, updated.config ?? {}, updated.enabled, {
            previousConfig,
            additive: isScopedKey(apiKey),
        });
        // Audit the successful update with the CHANGED FIELD NAMES only — never the values: a config patch
        // can carry credentials, and audit metadata is not a credential store.
        const updatedFields = ['enabled', 'sessionScope', 'config'].filter(f => dto[f] !== undefined);
        void this.audit.logInfo(audit_log_entity_1.AuditAction.INTEGRATION_INSTANCE_UPDATED, {
            metadata: { pluginId, instanceId, updated: updatedFields },
        });
        return this.view(updated, this.pluginRoutes(pluginId), false);
    }
    async remove(pluginId, instanceId, apiKey) {
        const inst = await this.resolveVisible(pluginId, instanceId, apiKey);
        const scope = inst.sessionScope;
        // Delete the row FIRST, then tear down its scope: for a wildcard/null scope the teardown lists the
        // remaining instances to decide whether to retire '*', and that check must not count this instance.
        await this.instances.remove(pluginId, instanceId);
        await this.scopeBinding.applyScopeBinding(pluginId, scope, {}, false, {
            previousConfig: contributedConfig(inst),
            additive: isScopedKey(apiKey),
        });
        void this.audit.logInfo(audit_log_entity_1.AuditAction.INTEGRATION_INSTANCE_DELETED, { metadata: { pluginId, instanceId } });
    }
    // Resolve an instance the calling key may see: a session-scoped key only reaches instances bound
    // to one of its own sessions. Out-of-scope instances answer 404 (identical to a missing one) so
    // the endpoint cannot be used to probe which instances exist on other sessions.
    async resolveVisible(pluginId, instanceId, apiKey) {
        const inst = await this.instances.resolve(pluginId, instanceId);
        if (!inst || !(0, session_scope_1.sessionScopeVisible)(apiKey?.allowedSessions, inst.sessionScope)) {
            throw new common_1.NotFoundException('instance not found');
        }
        return inst;
    }
    // A scoped key may only bind an instance to a session inside its own fence — never to another
    // session, and never to the all-sessions (omitted/'*') scope.
    assertScopeWritable(apiKey, sessionScope) {
        if (!(0, session_scope_1.sessionScopeVisible)(apiKey?.allowedSessions, sessionScope)) {
            throw new common_1.ForbiddenException("sessionScope is outside the API key's allowed sessions");
        }
    }
    // The plugin must exist AND declare ingress + the webhook:ingress permission to have instances.
    assertIngressCapable(pluginId) {
        const plugin = this.loader.getPlugin(pluginId);
        if (!plugin)
            throw new common_1.NotFoundException(`plugin ${pluginId} not found`);
        const routes = plugin.manifest.ingress?.map(r => r.route) ?? [];
        const hasPerm = (plugin.manifest.permissions ?? []).includes('webhook:ingress');
        if (routes.length === 0 || !hasPerm) {
            throw new common_1.BadRequestException(`plugin ${pluginId} is not ingress-capable`);
        }
        return routes;
    }
    // Best-effort routes for read responses; empty when the plugin is gone or non-ingress (no throw).
    pluginRoutes(pluginId) {
        return this.loader.getPlugin(pluginId)?.manifest.ingress?.map(r => r.route) ?? [];
    }
    // The plugin's declarative config schema, used to restore masked secrets on update (undefined when the
    // plugin is unloaded — restoreSecretConfig then fails closed).
    schemaFor(pluginId) {
        return this.loader.getPlugin(pluginId)?.manifest.configSchema;
    }
    view(inst, routes, reveal) {
        const schema = this.loader.getPlugin(inst.pluginId)?.manifest.configSchema;
        // ALWAYS start from the masked view — including the one-shot reveal responses (create /
        // regenerate-secret). `reveal` unmasks ONLY the two fields documented as "revealed once" (the
        // ingress secret and the verifyToken); config fields flagged `secret` in the plugin's schema
        // stay masked at any depth on every response, so a reveal can never echo a stored credential.
        const masked = this.instances.maskedView(inst, schema);
        return {
            id: masked.id,
            pluginId: masked.pluginId,
            instanceId: masked.instanceId,
            sessionScope: masked.sessionScope,
            secret: reveal ? inst.secret : masked.secret,
            verifyToken: reveal ? inst.verifyToken : inst.verifyToken ? '***' : null,
            config: masked.config,
            enabled: masked.enabled,
            createdAt: masked.createdAt,
            updatedAt: masked.updatedAt,
            ingressUrls: (0, ingress_url_1.buildIngressUrls)(process.env.BASE_URL, inst.pluginId, inst.instanceId, routes),
        };
    }
};
exports.IntegrationInstanceController = IntegrationInstanceController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(201),
    (0, swagger_1.ApiResponse)({
        status: 201,
        description: 'Instance created. The plaintext ingress secret and verifyToken are revealed once in this response — store them immediately (both masked on every later read).',
        type: instance_dto_1.InstanceView,
    }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Validation failed, or the plugin is not ingress-capable.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: "sessionScope is outside the key's allowedSessions." }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Plugin not found.' }),
    (0, swagger_1.ApiResponse)({ status: 409, description: 'An instance with that id already exists for the plugin' }),
    __param(0, (0, common_1.Param)('pluginId')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, auth_decorators_1.CurrentApiKey)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, instance_dto_1.CreateInstanceDto, Function]),
    __metadata("design:returntype", Promise)
], IntegrationInstanceController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Instances for the plugin (secrets masked).', type: [instance_dto_1.InstanceView] }),
    __param(0, (0, common_1.Param)('pluginId')),
    __param(1, (0, auth_decorators_1.CurrentApiKey)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Function]),
    __metadata("design:returntype", Promise)
], IntegrationInstanceController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(':instanceId'),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'The instance (secret masked).', type: instance_dto_1.InstanceView }),
    (0, swagger_1.ApiResponse)({ status: 404, description: "Unknown instance, or one outside the key's allowedSessions." }),
    __param(0, (0, common_1.Param)('pluginId')),
    __param(1, (0, common_1.Param)('instanceId')),
    __param(2, (0, auth_decorators_1.CurrentApiKey)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Function]),
    __metadata("design:returntype", Promise)
], IntegrationInstanceController.prototype, "getOne", null);
__decorate([
    (0, common_1.Post)(':instanceId/regenerate-secret'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiResponse)({
        status: 200,
        description: 'Secret regenerated. The new plaintext secret is revealed once in this response; the verifyToken is also shown (unchanged).',
        type: instance_dto_1.InstanceView,
    }),
    (0, swagger_1.ApiResponse)({ status: 404, description: "Unknown instance, or one outside the key's allowedSessions." }),
    __param(0, (0, common_1.Param)('pluginId')),
    __param(1, (0, common_1.Param)('instanceId')),
    __param(2, (0, auth_decorators_1.CurrentApiKey)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Function]),
    __metadata("design:returntype", Promise)
], IntegrationInstanceController.prototype, "regenerate", null);
__decorate([
    (0, common_1.Patch)(':instanceId'),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Instance updated (secret masked).', type: instance_dto_1.InstanceView }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Validation failed, or the masked config could not be restored.' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: "The new sessionScope is outside the key's allowedSessions." }),
    (0, swagger_1.ApiResponse)({ status: 404, description: "Unknown instance, or one outside the key's allowedSessions." }),
    (0, swagger_1.ApiResponse)({
        status: 409,
        description: 'The body changes config while the plugin is not loaded. Nothing is written; a body without config still ' +
            'applies enabled and sessionScope.',
    }),
    __param(0, (0, common_1.Param)('pluginId')),
    __param(1, (0, common_1.Param)('instanceId')),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, auth_decorators_1.CurrentApiKey)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, instance_dto_1.UpdateInstanceDto, Function]),
    __metadata("design:returntype", Promise)
], IntegrationInstanceController.prototype, "patch", null);
__decorate([
    (0, common_1.Delete)(':instanceId'),
    (0, common_1.HttpCode)(204),
    (0, swagger_1.ApiResponse)({ status: 204, description: 'Instance deleted and its session scope torn down.' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: "Unknown instance, or one outside the key's allowedSessions." }),
    (0, swagger_1.ApiResponse)({
        status: 503,
        description: 'On SQLite, another database transaction stayed open for 10 s; nothing was deleted, so retry.',
    }),
    __param(0, (0, common_1.Param)('pluginId')),
    __param(1, (0, common_1.Param)('instanceId')),
    __param(2, (0, auth_decorators_1.CurrentApiKey)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Function]),
    __metadata("design:returntype", Promise)
], IntegrationInstanceController.prototype, "remove", null);
exports.IntegrationInstanceController = IntegrationInstanceController = __decorate([
    (0, swagger_1.ApiTags)('integration'),
    (0, common_1.Controller)('integration/plugins/:pluginId/instances'),
    (0, auth_decorators_1.RequireRole)(api_key_entity_1.ApiKeyRole.ADMIN),
    __metadata("design:paramtypes", [plugin_instance_service_1.PluginInstanceService,
        plugin_loader_service_1.PluginLoaderService,
        audit_service_1.AuditService,
        scope_binding_service_1.ScopeBindingService])
], IntegrationInstanceController);
