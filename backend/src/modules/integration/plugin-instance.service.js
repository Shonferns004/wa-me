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
exports.PluginInstanceService = exports.InstanceExistsError = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const plugin_instance_entity_1 = require("./entities/plugin-instance.entity");
const conversation_mapping_entity_1 = require("./entities/conversation-mapping.entity");
const db_errors_1 = require("../../common/utils/db-errors");
const shared_connection_1 = require("../../common/utils/shared-connection");
const plugin_activation_1 = require("../../core/plugins/plugin-activation");
const redact_config_1 = require("../plugins/redact-config");
// A supplied ingress secret must be a real, guessing-resistant value; an empty/short one would make the
// public HMAC forgeable. Absent => auto-generate. Trimmed so pasted whitespace can't slip a weak secret in.
function normalizeSecret(supplied) {
    if (supplied === undefined)
        return (0, node_crypto_1.randomBytes)(32).toString('hex');
    const s = supplied.trim();
    if (s.length < 16) {
        throw new common_1.BadRequestException('instance secret must be a non-empty string of at least 16 characters');
    }
    return s;
}
class InstanceExistsError extends Error {
    constructor(pluginId, instanceId) {
        super(`instance ${instanceId} already exists for plugin ${pluginId}`);
        this.name = 'InstanceExistsError';
    }
}
exports.InstanceExistsError = InstanceExistsError;
let PluginInstanceService = class PluginInstanceService {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    async mint(pluginId, instanceId, opts) {
        const existing = await this.resolve(pluginId, instanceId);
        if (existing)
            return existing;
        return ((await this.insert(pluginId, instanceId, opts)) ?? (await this.resolve(pluginId, instanceId)));
    }
    // A plain INSERT, never save(): with the primary key set, save() re-selects and turns a concurrent
    // duplicate into an UPDATE that overwrites the first row's secret. Null when the id already exists.
    async insert(pluginId, instanceId, opts) {
        const inst = this.repo.create({
            id: `${pluginId}:${instanceId}`,
            pluginId,
            instanceId,
            sessionScope: opts.sessionScope || null,
            secret: normalizeSecret(opts.secret),
            verifyToken: opts.verifyToken || (0, node_crypto_1.randomBytes)(16).toString('hex'),
            config: opts.config ?? null,
            enabled: true,
        });
        try {
            await this.repo.insert(inst);
        }
        catch (err) {
            if ((0, db_errors_1.isUniqueViolation)(err))
                return null;
            throw err;
        }
        return inst;
    }
    resolve(pluginId, instanceId) {
        return this.repo.findOne({ where: { id: `${pluginId}:${instanceId}` } });
    }
    // Operator-facing view: never leak the raw secret, and mask any `secret:true` config field (e.g. a
    // provider apiToken) per the plugin's configSchema — recursively, at any depth, and fail-closed when
    // the schema is unavailable — by reusing the shared redactSecretConfig (single source of truth).
    maskedView(instance, schema) {
        return {
            ...instance,
            secret: redact_config_1.SECRET_SENTINEL,
            config: instance.config == null ? instance.config : (0, redact_config_1.redactSecretConfig)(instance.config, schema),
        };
    }
    async create(pluginId, instanceId, opts) {
        if (await this.resolve(pluginId, instanceId))
            throw new InstanceExistsError(pluginId, instanceId);
        const inst = await this.insert(pluginId, instanceId, opts);
        if (!inst)
            throw new InstanceExistsError(pluginId, instanceId);
        return inst;
    }
    list(pluginId) {
        return this.repo.find({ where: { pluginId } });
    }
    /** Every persisted instance across all plugins — used by the boot-time scope-binding reconciliation. */
    listAll() {
        return this.repo.find();
    }
    // update() and regenerateSecret() write only the columns they change, and only to a row that still
    // exists: a whole-row save() would re-insert a row deleted meanwhile, or write back a stale secret
    // over a concurrent rotation. Both re-read the row after the write so the result carries the fresh
    // updatedAt the database stamped.
    async regenerateSecret(pluginId, instanceId) {
        const inst = await this.resolve(pluginId, instanceId);
        const secret = (0, node_crypto_1.randomBytes)(32).toString('hex');
        const written = inst ? (await this.repo.update({ id: inst.id }, { secret })).affected : 0;
        return written ? this.resolve(pluginId, instanceId) : null;
    }
    async update(pluginId, instanceId, patch, schema, layer) {
        const inst = await this.resolve(pluginId, instanceId);
        if (!inst)
            return null;
        const changes = {};
        if (patch.enabled !== undefined)
            changes.enabled = patch.enabled;
        if (patch.sessionScope !== undefined)
            changes.sessionScope = patch.sessionScope || null;
        if (patch.config !== undefined) {
            // The operator view masks secrets as the sentinel, so a round-tripped config carries '***' for
            // unchanged secrets. Restore the stored values instead of persisting the mask (which would corrupt
            // the credential); genuinely-new values are written as provided.
            // A PATCH that points a host key at another origin gets no stored secret back, see restorableConfig.
            const stored = (0, plugin_activation_1.restorableConfig)(inst.config ?? undefined, patch.config, { configSchema: schema, net: layer?.net }, layer?.beneath);
            changes.config = (0, redact_config_1.restoreSecretConfig)(patch.config, stored, schema);
        }
        if (Object.keys(changes).length === 0)
            return inst;
        const { affected } = await this.repo.update({ id: inst.id }, changes);
        return affected ? this.resolve(pluginId, instanceId) : null;
    }
    async remove(pluginId, instanceId) {
        // On SQLite every caller shares one connection: opened beside another caller's transaction, this one would be a
        // savepoint in it or carry that one's writes, and either rollback could undo what the other had answered for.
        if (!(await (0, shared_connection_1.awaitNoOpenTransaction)(this.repo.manager.dataSource))) {
            throw new common_1.ServiceUnavailableException(`Instance ${instanceId} was not deleted: another database transaction stayed open. Retry the delete.`);
        }
        return this.repo.manager.transaction(async (manager) => {
            const result = await manager.delete(plugin_instance_entity_1.PluginInstance, { id: `${pluginId}:${instanceId}` });
            // Its conversation mappings stay, so the same instance provisioned again keeps its provider
            // conversations. A takeover they hold does not: it is scoped to the chat, not to the plugin, and
            // with the instance gone nothing can hand the chat back, so it would keep every other plugin
            // silent there for good.
            await manager.update(conversation_mapping_entity_1.ConversationMapping, { pluginId, instanceId, handoverState: (0, typeorm_2.In)(['human', 'closed']) }, { handoverState: 'bot' });
            return (result.affected ?? 0) > 0;
        });
    }
};
exports.PluginInstanceService = PluginInstanceService;
exports.PluginInstanceService = PluginInstanceService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(plugin_instance_entity_1.PluginInstance, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], PluginInstanceService);
