"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const throttler_1 = require("@nestjs/throttler");
const plugin_instance_entity_1 = require("./entities/plugin-instance.entity");
const ingress_event_entity_1 = require("./entities/ingress-event.entity");
const integration_delivery_failure_entity_1 = require("./entities/integration-delivery-failure.entity");
const plugin_instance_service_1 = require("./plugin-instance.service");
const ingress_event_service_1 = require("./ingress-event.service");
const ingress_service_1 = require("./ingress.service");
const ingress_controller_1 = require("./ingress.controller");
const ingress_instance_limit_1 = require("./ingress-instance-limit");
const ingress_enqueue_service_1 = require("./ingress-enqueue.service");
const ingress_reconciler_service_1 = require("./ingress-reconciler.service");
const redrive_service_1 = require("./redrive.service");
const redrive_controller_1 = require("./redrive.controller");
const integration_retention_service_1 = require("./integration-retention.service");
const integration_instance_controller_1 = require("./integration-instance.controller");
const scope_binding_service_1 = require("./scope-binding.service");
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const plugin_host_ports_1 = require("../../core/plugins/plugin-host-ports");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const session_entity_1 = require("../session/entities/session.entity");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * Wires the @Public ingress HTTP surface: instance/event persistence services and the fast-ack
 * IngressService, whose deps are built by a factory so the pure pipeline stays DI-free and testable.
 * Queue-vs-inline enqueue is delegated to IngressEnqueueService (its own optional-queue injection),
 * shared with RedriveService so a DLQ replay goes through the exact same path a live delivery would.
 * PluginLoaderService is @Global (PluginsModule), so it injects without importing that module.
 * QueueModule must be imported here (not only at the app root): @nestjs/bullmq queue providers are
 * module-scoped, so IngressEnqueueService's @InjectQueue(QUEUE_NAMES.INGRESS) only resolves when this
 * module imports the module that registered the queue. IngressEnqueueService fails fast at boot if
 * QUEUE_ENABLED=true but the queue still did not resolve.
 */
// Only import QueueModule if explicitly enabled to avoid Redis connection errors
const queueModules = [];
if (process.env.QUEUE_ENABLED === 'true') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const queueModule = require('../queue/queue.module');
    queueModules.push(queueModule.QueueModule);
}
let IntegrationModule = class IntegrationModule {
};
exports.IntegrationModule = IntegrationModule;
exports.IntegrationModule = IntegrationModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([plugin_instance_entity_1.PluginInstance, ingress_event_entity_1.IngressEvent, integration_delivery_failure_entity_1.IntegrationDeliveryFailure, session_entity_1.Session], 'data'),
            ...queueModules,
        ],
        controllers: [ingress_controller_1.IngressController, redrive_controller_1.RedriveController, integration_instance_controller_1.IntegrationInstanceController],
        providers: [
            plugin_instance_service_1.PluginInstanceService,
            ingress_event_service_1.IngressEventService,
            ingress_enqueue_service_1.IngressEnqueueService,
            ingress_reconciler_service_1.IngressReconcilerService,
            redrive_service_1.RedriveService,
            scope_binding_service_1.ScopeBindingService,
            integration_retention_service_1.IntegrationRetentionService,
            // Binds the core-owned plugin capability port to this module's service; resolved lazily by the
            // plugin runtime (PluginHostServices) so its provider cycle stays broken.
            // An alias, not a factory, so lifecycle hooks are not dispatched twice on the same instance.
            { provide: plugin_host_ports_1.PLUGIN_INSTANCE_PORT, useExisting: plugin_instance_service_1.PluginInstanceService },
            {
                provide: ingress_service_1.IngressService,
                inject: [
                    plugin_instance_service_1.PluginInstanceService,
                    ingress_event_service_1.IngressEventService,
                    plugin_loader_service_1.PluginLoaderService,
                    ingress_enqueue_service_1.IngressEnqueueService,
                    (0, typeorm_1.getRepositoryToken)(integration_delivery_failure_entity_1.IntegrationDeliveryFailure, 'data'),
                    engine_registry_service_1.EngineRegistry,
                    throttler_1.ThrottlerStorage,
                ],
                useFactory: (instances, events, loader, ingressEnqueue, failures, registry, throttlerStorage) => {
                    const dlqLogger = (0, logger_service_1.createLogger)('IngressEnqueue');
                    const ingressLogger = (0, logger_service_1.createLogger)('Ingress');
                    return new ingress_service_1.IngressService({
                        instances: { resolve: (pluginId, instanceId) => instances.resolve(pluginId, instanceId) },
                        manifestRoute: (pluginId, route) => loader.getPlugin(pluginId)?.manifest.ingress?.find(r => r.route === route),
                        events: { recordOrSkip: input => events.recordOrSkip(input) },
                        // O(1) in-memory liveness probe for the `session-alive` preflight: a Map read + a field read.
                        // MUST stay cheap — never call engine.initialize() here (that is the slow/blocking path bounded
                        // separately by the #667/#696 init-timeout). Undefined = no live engine (stopped/deleted).
                        sessionStatus: (scope) => registry.get(scope)?.getStatus(),
                        // A plugin the boot restore has not reached has no worker to take a delivery. A route that wants an
                        // answer is refused with a retryable 503 before anything is persisted; any other is accepted and held.
                        restorePending: (pluginId) => loader.isRestorePending(pluginId),
                        // Queue off: the dispatch would run inline, so the persisted row waits for the reconciler. With the
                        // reconciler off nothing would ever replay it, so the inline attempt (and its dead letter) stays.
                        deferDispatch: (pluginId) => ingressEnqueue.defersInlineDispatch(pluginId) && (0, ingress_reconciler_service_1.resolveIngressReconcilerOptions)().intervalMs > 0,
                        // Audit sink for preflight rejections (they leave no dedup/DLQ row). The Prometheus counter is
                        // a separate follow-up (see plan notes); the structured log is the MVP audit surface.
                        log: (event, meta) => ingressLogger.warn(event, meta),
                        // The app's global throttler storage (Redis when enabled), so the bucket is shared across nodes.
                        admitInstance: (pluginId, instanceId) => (0, ingress_instance_limit_1.admitIngressInstance)(throttlerStorage, pluginId, instanceId),
                        // Live ingress delivery: record the dispatch outcome on the event row (so the reconciler
                        // can tell a stranded 'pending' row from one that reached the dispatch tier) and, on a
                        // swallowed inline-dispatch failure, persist a dead-letter row so RedriveService can replay
                        // it — IngressService.handle() always 202s, so nothing else would. RedriveService calls
                        // enqueue() directly (it is already replaying a DLQ row) so it never double-writes here.
                        // Both writes are best-effort: a failure must not 500 the ingress request (the delivery is
                        // already dedup-persisted, so the provider won't re-send; an unmarked row stays 'pending'
                        // and the reconciler replays it — at-least-once, plugin handlers are idempotent by contract).
                        enqueue: async (data, jobId) => {
                            const result = await ingressEnqueue.enqueue(data, jobId);
                            try {
                                await events.markDispatchOutcome({ pluginId: data.pluginId, instanceId: data.instanceId, providerDeliveryId: data.deliveryId }, result.outcome);
                            }
                            catch (err) {
                                dlqLogger.error('Failed to mark ingress dispatch outcome', err instanceof Error ? err.message : String(err), { pluginId: data.pluginId, instanceId: data.instanceId, deliveryId: data.deliveryId });
                            }
                            if (result.outcome === 'failed') {
                                try {
                                    await failures.save((0, ingress_enqueue_service_1.buildIngressDeadLetterRow)(data, result.error));
                                }
                                catch (err) {
                                    dlqLogger.error('Failed to persist ingress dead-letter row after inline dispatch failure', err instanceof Error ? err.message : String(err), { pluginId: data.pluginId, instanceId: data.instanceId, deliveryId: data.deliveryId });
                                }
                            }
                            return result;
                        },
                        now: () => Date.now(),
                    });
                },
            },
        ],
        exports: [plugin_instance_service_1.PluginInstanceService, ingress_event_service_1.IngressEventService],
    })
], IntegrationModule);
