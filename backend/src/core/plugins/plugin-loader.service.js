"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginLoaderService = exports.PLUGIN_RESTORE_BOOT_BUDGET_MS = exports.PLUGIN_SHUTDOWN_WAIT_MS = exports.pluginUpdateBackupDirName = exports.pluginUpdateStagingDirName = exports.resolvePluginEntryPath = exports.resolvePluginMainPath = void 0;
exports.buildSandboxWorkerEnv = buildSandboxWorkerEnv;
const shutdown_service_1 = require("../../common/services/shutdown.service");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const path = __importStar(require("path"));
const configuration_1 = require("../../config/configuration");
const logger_service_1 = require("../../common/services/logger.service");
const hooks_1 = require("../hooks");
const plugin_interfaces_1 = require("./plugin.interfaces");
const plugin_storage_service_1 = require("./plugin-storage.service");
const plugin_host_services_1 = require("./plugin-host-services");
const plugin_capability_context_1 = require("./plugin-capability-context");
const plugin_sandbox_bridge_1 = require("./plugin-sandbox-bridge");
const plugin_package_scanner_1 = require("./plugin-package-scanner");
const plugin_lifecycle_1 = require("./plugin-lifecycle");
const plugin_uninstaller_1 = require("./plugin-uninstaller");
const plugin_worker_host_1 = require("./sandbox/plugin-worker-host");
const worker_thread_channel_1 = require("./sandbox/worker-thread-channel");
const plugin_paths_1 = require("./plugin-paths");
// The shared path/containment helpers stay re-exported from this module: the feature-side installer
// (PluginsService) and the specs import them from here / from the core barrel.
var plugin_paths_2 = require("./plugin-paths");
Object.defineProperty(exports, "resolvePluginMainPath", { enumerable: true, get: function () { return plugin_paths_2.resolvePluginMainPath; } });
Object.defineProperty(exports, "resolvePluginEntryPath", { enumerable: true, get: function () { return plugin_paths_2.resolvePluginEntryPath; } });
Object.defineProperty(exports, "pluginUpdateStagingDirName", { enumerable: true, get: function () { return plugin_paths_2.pluginUpdateStagingDirName; } });
Object.defineProperty(exports, "pluginUpdateBackupDirName", { enumerable: true, get: function () { return plugin_paths_2.pluginUpdateBackupDirName; } });
/** Default per-plugin heap cap for the sandbox worker; an OOM terminates the worker, not the host. */
const SANDBOX_MAX_OLD_GEN_MB = 256;
/**
 * Max concurrent worker-initiated capability calls per sandboxed plugin. A burst beyond this is rejected
 * (the plugin sees a thrown Error) rather than amplified into unbounded host-side sends/fetches/writes.
 */
const SANDBOX_MAX_INFLIGHT_CAPS = 32;
/**
 * Host-side budget for ONE worker-initiated capability call. A plugin whose calls hang would otherwise
 * hold all SANDBOX_MAX_INFLIGHT_CAPS slots forever (self-DoS). On timeout the worker gets an error and
 * the slot frees; the late-settling host work is only WARN-logged (see PluginWorkerHost.withCapTimeout —
 * a bound, not an atomicity guarantee). Default; plugins.capTimeoutMs (PLUGIN_CAP_TIMEOUT_MS) overrides.
 */
const SANDBOX_CAP_TIMEOUT_MS = 30000;
/** Total time the plugin shutdown phase may take (disable pass, in-flight enables, second pass). See shutdown-budget.ts. */
exports.PLUGIN_SHUTDOWN_WAIT_MS = 10_000;
/**
 * Longest the boot waits for the operator-enabled plugins to be restored before the gateway starts
 * listening. Under the Docker health check's retries and the Helm startup probe, and above what a healthy
 * plugin needs. See onApplicationBootstrap for what a plugin that is still restoring misses meanwhile.
 */
exports.PLUGIN_RESTORE_BOOT_BUDGET_MS = 60_000;
/**
 * How long a worker has to answer the liveness ping the host sends after a dispatch times out. A worker
 * stuck in a synchronous loop is terminated about 5 s after its first dispatch timeout (about 10 s after
 * a stalled hook or ingress dispatch, 15 s after a stalled search); a slow async handler answers at once
 * and is never affected.
 */
const SANDBOX_LIVENESS_TIMEOUT_MS = 5000;
/**
 * Host process.env keys an untrusted plugin worker is allowed to see. Everything else (secrets like
 * API_MASTER_KEY, API_KEY_PEPPER, the DATABASE_/REDIS_ vars, DOCKER_HOST) is left out of the worker's
 * process.env object. That keeps secrets from being handed over ambiently; it does not put them out of
 * reach, since a thread in the same OS process can read /proc/self/environ and the data directory. The
 * worker is a thread, so it needs no PATH to start and require() resolves via module paths, not env.
 */
const SANDBOX_ENV_ALLOWLIST = ['NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'TZ'];
/**
 * Build the minimal, allowlisted env for a plugin worker so its process.env never carries host secrets.
 * Only {@link SANDBOX_ENV_ALLOWLIST} keys are forwarded (unset keys are omitted, not emitted as
 * `undefined`), and NODE_ENV defaults to 'production' when the host has none.
 */
function buildSandboxWorkerEnv(source = process.env) {
    const env = {};
    for (const key of SANDBOX_ENV_ALLOWLIST) {
        if (source[key] !== undefined)
            env[key] = source[key];
    }
    env.NODE_ENV = source.NODE_ENV ?? 'production';
    return env;
}
/**
 * The public facade of the plugin runtime. Every consumer — the REST surface, the installer, the
 * engine factory, the ingress pipeline — keeps calling this class; the jobs behind the surface are
 * collocated collaborators constructed below, each owning one job and sharing the loader's registry
 * Maps BY REFERENCE (so the specs that poke them on the loader and the collaborators see one map):
 *
 * - {@link PluginPackageScanner} — boot scan/registry: find packages on disk, validate manifests,
 *   recover interrupted updates, keep the persisted registry entries honest.
 * - {@link PluginLifecycle} — enable/disable/unload, config + per-session activation writes,
 *   programmatic built-in registration.
 * - {@link PluginUninstaller} — full removal of an installed user plugin.
 * - {@link PluginCapabilityContext} — the capability surface handed to plugins.
 * - {@link PluginSandboxBridge} — the sandboxed-worker IPC bridge (spawn/teardown, relay, health,
 *   ingress dispatch). The loader keeps only the protected worker-host factory seam the bridge
 *   calls back through, so spec subclasses can still inject fakes.
 *
 * What remains HERE is the facade itself: the Nest lifecycle hooks, the registry reads, and the
 * delegation to each collaborator.
 */
let PluginLoaderService = class PluginLoaderService {
    configService;
    hookManager;
    pluginStorage;
    moduleRef;
    lidMappingStore;
    shutdownService;
    logger = (0, logger_service_1.createLogger)('PluginLoaderService');
    plugins = new Map();
    // Live worker host per enabled sandboxed (untrusted) plugin. Built-ins are not in here.
    sandboxHosts = new Map();
    // Last hook-handler error each sandboxed plugin's worker reported, surfaced via checkPluginHealth so a
    // hook that keeps throwing is visible to the operator. Scoped to ONE worker generation: cleared when a
    // generation starts (enableSandboxed) and when one is deliberately ended (disablePlugin). Clearing at
    // the start is what makes it hold for a crash or a failed enable, neither of which runs a disable.
    lastSandboxHookError = new Map();
    pluginsDir;
    /**
     * The package dir OpenWA defaulted to before it moved under <dataDir>. Scanned as a compatibility
     * fallback so a host that installed plugins there keeps loading them; null when PLUGINS_DIR names a
     * directory explicitly, and null for a ConfigService that carries no app config (unit tests).
     */
    legacyPluginsDir;
    /** Resolves the host service ports at call time; see PluginHostServices for why it is not ctor-injected. */
    hostServices;
    /** Owns the capability surface handed to plugins — permissions, session scope, engine resolution. */
    capabilities;
    /** Owns the sandboxed-worker IPC bridge — enable/teardown, hook/log relay, health + webhook dispatch. */
    sandboxBridge;
    /** Owns the boot scan/registry job — package discovery, manifest validation, crash recovery. */
    scanner;
    /** Owns the runtime job — enable/disable/unload, config + session activation writes, built-in registration. */
    lifecycle;
    /** Owns the removal job — uninstall of an installed user plugin. */
    uninstaller;
    /** Set when shutdown teardown begins; from then on no enable may start. */
    shuttingDown = false;
    /** Enables in flight, awaited by onModuleDestroy so one that lands during teardown is still disabled. */
    pendingEnables = new Set();
    constructor(configService, hookManager, pluginStorage, 
    // Handed straight to PluginHostServices below, which owns the reasoning: ModuleRef rather than
    // constructor injection avoids the provider cycle
    // PluginLoaderService -> SessionService -> SessionEngineLifecycle -> EngineFactory -> PluginLoaderService.
    moduleRef, lidMappingStore, shutdownService) {
        this.configService = configService;
        this.hookManager = hookManager;
        this.pluginStorage = pluginStorage;
        this.moduleRef = moduleRef;
        this.lidMappingStore = lidMappingStore;
        this.shutdownService = shutdownService;
        // Same default the `plugins.dir` key is built from, so this fallback cannot drift away from the
        // tree PluginStorageService keeps the registry and each plugin's ctx.storage in.
        this.pluginsDir = this.configService.get('plugins.dir') ?? configuration_1.DEFAULT_PLUGINS_DIR;
        this.legacyPluginsDir = this.configService.get('plugins.legacyDir') ?? null;
        this.hostServices = new plugin_host_services_1.PluginHostServices(this.moduleRef);
        this.capabilities = new plugin_capability_context_1.PluginCapabilityContext(this.logger, this.hostServices, this.hookManager, this.pluginStorage, this.lidMappingStore);
        this.sandboxBridge = new plugin_sandbox_bridge_1.PluginSandboxBridge(this.logger, this.hookManager, this.capabilities, this.hostServices, this.configService, this.pluginStorage, 
        // Shared BY REFERENCE: specs poke these Maps on the loader via casts, so the bridge and the
        // loader must see one and the same map, not two copies.
        this.plugins, this.sandboxHosts, this.lastSandboxHookError, this.pluginsDir, 
        // A closure, not a method reference: virtual dispatch keeps a subclass's createSandboxHost
        // override (the sandbox specs' worker-host seam) in effect through the bridge.
        (capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, onSearchProviderRegister, onWorkerExit, onUnresponsive) => this.createSandboxHost(capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, onSearchProviderRegister, onWorkerExit, onUnresponsive), 
        // Exported from this module (specs import it here); passed so the bridge never imports back.
        plugin_paths_1.resolvePluginMainPath);
        this.scanner = new plugin_package_scanner_1.PluginPackageScanner(this.logger, this.configService, this.pluginStorage, this.pluginsDir, this.legacyPluginsDir, 
        // Shared BY REFERENCE, like the bridge's maps: the loader's registry reads below and the
        // scanner's writes are one and the same map.
        this.plugins);
        this.lifecycle = new plugin_lifecycle_1.PluginLifecycle(this.logger, this.configService, this.hookManager, this.pluginStorage, this.capabilities, this.sandboxBridge, this.hostServices, (manifest, builtIn) => this.scanner.ensureRegistryEntry(manifest, builtIn), this.plugins, this.sandboxHosts, this.lastSandboxHookError, this.pluginsDir);
        this.uninstaller = new plugin_uninstaller_1.PluginUninstaller(this.logger, this.plugins, this.pluginStorage, this.pluginsDir, pluginId => this.lifecycle.unloadPlugin(pluginId), this.legacyPluginsDir, pluginId => this.releaseTakeovers(pluginId));
    }
    onModuleInit() {
        this.scanner.scanAtBoot();
        // Marked now, though restored at bootstrap: the BullMQ workers start in between, and a queued ingress job
        // they take for one of these plugins must be held (isRestorePending), not dispatched to a missing worker.
        this.queueRestore();
    }
    /** Hand back the chats a plugin took over. A host without the conversation store has none to hand back. */
    releaseTakeovers(pluginId) {
        let port;
        try {
            port = this.hostServices.getConversationMappingPort();
        }
        catch {
            return Promise.resolve();
        }
        return port.releaseTakeovers(pluginId);
    }
    /**
     * Re-enable the plugins the operator had enabled (#856). `status` cannot carry that across a restart
     * — it describes the runtime, and loading never runs a plugin — so the decision is read from the
     * separately persisted `enabledByOperator`. Without this, every restart (an upgrade, a host reboot, a
     * Docker restart policy) silently switched off every extension, and a relay simply stopped relaying.
     *
     * Runs at bootstrap rather than in onModuleInit so the rest of the app is wired before any plugin
     * code executes. Built-ins are skipped: an engine is enabled by EngineFactory against the configured
     * engine.type, and enabling a non-active engine here would be rejected anyway.
     *
     * Best-effort and sequential: a plugin that cannot come back is logged and left in ERROR. The HTTP
     * port opens only after this hook returns, and one plugin can take up to 90 s here (load, onLoad and
     * onEnable are each bounded at 30 s), so the wait is capped at PLUGIN_RESTORE_BOOT_BUDGET_MS. Plugins not
     * yet restored when it ends keep coming up, in order, in the background. The trade-off is deliberate:
     * until they are up, the hooks they own (a send moderation veto, for one) are not active, so a request
     * that arrives in that window is not seen by them. Without the cap, plugins whose backends are down after
     * an outage kept the whole gateway from listening and could fail its health checks into a restart loop.
     * A plugin the restore has not finished with also takes no lifecycle change from the operator meanwhile
     * (isRestorePending).
     */
    async onApplicationBootstrap() {
        const restoring = this.restorePlugins();
        let timer;
        const settled = await Promise.race([
            restoring.then(() => true),
            new Promise(resolve => {
                timer = setTimeout(resolve, exports.PLUGIN_RESTORE_BOOT_BUDGET_MS, false);
            }),
        ]);
        clearTimeout(timer);
        if (!settled) {
            this.logger.warn('Plugin restore is still running; the gateway starts listening and the remaining plugins come up in the background', { waitMs: exports.PLUGIN_RESTORE_BOOT_BUDGET_MS, action: 'plugin_restore_deferred' });
        }
    }
    /** Plugins the boot restore has queued (from module init on) or is enabling, so no lifecycle change interleaves. */
    restorePending = new Set();
    /**
     * Whether the boot restore still has this plugin ahead of it or in flight. When the restore outlasts the
     * boot wait it runs while requests are served, and it enables outside the per-plugin operation chain of
     * PluginsService: a disable would be answered "not enabled" and then overtaken by the enable, and an
     * uninstall would leave a live worker without a map entry. PluginsService refuses such a change until the
     * restore is done with the plugin, which is what the closed port did before the boot wait was capped.
     */
    isRestorePending(id) {
        return this.restorePending.has(id);
    }
    /** The ids {@link isRestorePending} answers true for, for a caller that has to leave them out of a query. */
    restorePendingIds() {
        return [...this.restorePending];
    }
    /** Mark the plugins the operator had enabled as restoring, and return their ids in restore order. */
    queueRestore() {
        const ids = this.getAllPlugins()
            .filter(p => !p.builtIn && this.pluginStorage.getPluginEntry(p.manifest.id)?.enabledByOperator === true)
            .map(p => p.manifest.id);
        for (const id of ids)
            this.restorePending.add(id);
        return ids;
    }
    async restorePlugins() {
        const restorable = this.queueRestore();
        try {
            for (let i = 0; i < restorable.length; i++) {
                if (this.shuttingDown || this.shutdownService?.isShuttingDown()) {
                    this.logger.log(`Plugin restore stopped at ${i} of ${restorable.length} plugin(s): shutting down`, {
                        action: 'plugin_restore_aborted',
                    });
                    return;
                }
                const pluginId = restorable[i];
                try {
                    await this.enablePlugin(pluginId);
                }
                catch (error) {
                    this.logger.error(`Failed to restore plugin ${pluginId} on startup; it stays disabled until re-enabled`, error instanceof Error ? error.message : String(error), { pluginId, action: 'plugin_restore_failed' });
                }
                finally {
                    this.restorePending.delete(pluginId);
                }
            }
        }
        finally {
            this.restorePending.clear();
        }
    }
    /**
     * Graceful shutdown (SIGTERM → app.close()): run onDisable for every enabled plugin so it can flush
     * buffers, close connections, and persist state. Previously onDisable only ran via the REST disable
     * and uninstall paths, so a normal restart/deploy/scale-down skipped it and stateful plugins lost
     * in-flight work. Best-effort: plugins are disabled in parallel and one plugin's failure must not
     * block the others.
     *
     * Running plugins are disabled first, so a slow enable still in flight cannot hold back their onDisable.
     * Then the in-flight enables are awaited and a second pass disables the plugins that finished enabling
     * mid-teardown, instead of leaving them running with onDisable never called. Later enables are refused.
     *
     * The whole phase shares one cap, PLUGIN_SHUTDOWN_WAIT_MS, because a sandboxed plugin's lifecycle call
     * alone is bounded at 30 s and the destroy hooks after this one (database close, lease release) have
     * to finish inside the kill deadline. A sandbox worker still running at the cap dies with the process.
     */
    async onModuleDestroy() {
        this.shuttingDown = true;
        let timer;
        const done = await Promise.race([
            this.disableForShutdown().then(() => true),
            new Promise(resolve => {
                timer = setTimeout(resolve, exports.PLUGIN_SHUTDOWN_WAIT_MS, false);
            }),
        ]);
        clearTimeout(timer);
        if (!done) {
            this.logger.warn('Plugin shutdown still running at its time cap; continuing without it', {
                waitMs: exports.PLUGIN_SHUTDOWN_WAIT_MS,
                action: 'plugin_shutdown_timeout',
            });
        }
    }
    async disableForShutdown() {
        await this.disableEnabledPlugins();
        await Promise.allSettled(this.pendingEnables);
        await this.disableEnabledPlugins();
    }
    async disableEnabledPlugins() {
        const enabled = this.getAllPlugins().filter(p => p.status === plugin_interfaces_1.PluginStatus.ENABLED);
        await Promise.allSettled(enabled.map(async (plugin) => {
            try {
                await this.disablePlugin(plugin.manifest.id);
            }
            catch (error) {
                this.logger.error(`Failed to disable plugin ${plugin.manifest.id} during shutdown`, error instanceof Error ? error.message : String(error), { pluginId: plugin.manifest.id, action: 'plugin_shutdown_disable_failed' });
            }
        }));
    }
    /**
     * Record that the operator wants this plugin on (or off), so bootstrap can restore it (#856).
     *
     * Call this ONLY from an operator-facing action. In particular it must never be called from
     * disablePlugin: onModuleDestroy disables every running plugin during a graceful shutdown, and
     * treating that as "the operator turned it off" would erase the decision on the way out — which is
     * the very bug this exists to fix, just moved somewhere harder to see.
     */
    setOperatorEnabled(pluginId, enabled) {
        this.pluginStorage.setPluginEnabledByOperator(pluginId, enabled);
    }
    /**
     * The persisted registry entry for a plugin id, whether or not its code is currently loaded. Lets a
     * caller distinguish "installed but not loaded" — which still owns config, storage and the
     * `enabledByOperator` decision — from an id the gateway has genuinely never seen.
     */
    getRegistryEntry(pluginId) {
        return this.pluginStorage.getPluginEntry(pluginId);
    }
    loadPlugin(pluginPath) {
        return this.scanner.loadPlugin(pluginPath);
    }
    /** True once shutdown teardown has begun; enablePlugin refuses from then on. */
    isShuttingDown() {
        return this.shuttingDown;
    }
    async enablePlugin(pluginId) {
        if (this.shuttingDown) {
            throw new Error(`Plugin ${pluginId} cannot be enabled while the gateway is shutting down`);
        }
        const enabling = this.lifecycle.enablePlugin(pluginId);
        this.pendingEnables.add(enabling);
        try {
            await enabling;
        }
        finally {
            this.pendingEnables.delete(enabling);
        }
    }
    disablePlugin(pluginId, opts) {
        return this.lifecycle.disablePlugin(pluginId, opts);
    }
    unloadPlugin(pluginId) {
        return this.lifecycle.unloadPlugin(pluginId);
    }
    /** Absolute path of the directory user plugins are loaded from (used by install/uninstall). */
    getPluginsDir() {
        return this.pluginsDir;
    }
    /**
     * Absolute path of a plugin's own package directory — the tree its code was loaded from.
     *
     * Every operation that acts on the package (enable, uninstall, update, config UI) must use this
     * rather than <plugins.dir>/<id>: the loader also scans the legacy plugins directory, so those are
     * not the same path for a plugin a host has not migrated yet. Falls back to the configured
     * location for an id that is not loaded, which is what a fresh install wants.
     */
    getPluginPackageDir(pluginId) {
        return this.plugins.get(pluginId)?.packageDir ?? path.join(this.pluginsDir, pluginId);
    }
    /** Whether a plugin is a first-party built-in (engine / bundled extension) vs an installed user plugin. */
    isBuiltIn(pluginId) {
        return this.pluginStorage.getPluginEntry(pluginId)?.builtIn ?? false;
    }
    uninstallPlugin(pluginId) {
        return this.uninstaller.uninstallPlugin(pluginId);
    }
    updatePluginConfig(pluginId, config, opts) {
        this.lifecycle.updatePluginConfig(pluginId, config, opts);
    }
    setPluginSessions(pluginId, sessions, opts) {
        return this.lifecycle.setPluginSessions(pluginId, sessions, opts);
    }
    setPluginSessionConfig(pluginId, sessionId, config, opts) {
        return this.lifecycle.setPluginSessionConfig(pluginId, sessionId, config, opts);
    }
    /** Health across both tiers; the sandbox-routing implementation lives in PluginSandboxBridge. */
    checkPluginHealth(pluginId) {
        return this.sandboxBridge.checkPluginHealth(pluginId);
    }
    /**
     * Ingress dispatch into the plugin's live sandbox worker; implemented by PluginSandboxBridge.
     * The public contract (callers: IngressProcessor, IngressEnqueueService) is unchanged.
     */
    dispatchWebhookForInstance(d) {
        return this.sandboxBridge.dispatchWebhookForInstance(d);
    }
    /**
     * Build a worker host for a sandboxed (untrusted) plugin. Overridable so tests can inject a fake
     * instead of spawning a real OS thread. Production loads the compiled worker bootstrap from dist.
     */
    createSandboxHost(capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, onSearchProviderRegister, onWorkerExit, onUnresponsive) {
        const workerEntry = path.join(__dirname, 'sandbox', 'worker-bootstrap.js');
        return new plugin_worker_host_1.PluginWorkerHost(new worker_thread_channel_1.WorkerThreadChannel({
            workerEntry,
            maxOldGenerationSizeMb: SANDBOX_MAX_OLD_GEN_MB,
            // Withhold host secrets: the worker gets a minimal allowlisted env, not a copy of process.env.
            env: buildSandboxWorkerEnv(),
        }), capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, SANDBOX_MAX_INFLIGHT_CAPS, onSearchProviderRegister, onWorkerExit, this.configService.get('plugins.capTimeoutMs') ?? SANDBOX_CAP_TIMEOUT_MS, SANDBOX_LIVENESS_TIMEOUT_MS, onUnresponsive);
    }
    getPlugin(pluginId) {
        return this.plugins.get(pluginId);
    }
    getAllPlugins() {
        return Array.from(this.plugins.values());
    }
    getPluginsByType(type) {
        return this.getAllPlugins().filter(p => p.manifest.type === type);
    }
    isPluginEnabled(pluginId) {
        const plugin = this.plugins.get(pluginId);
        return plugin?.status === plugin_interfaces_1.PluginStatus.ENABLED;
    }
    registerBuiltInPlugin(manifest, instance, config = {}) {
        this.lifecycle.registerBuiltInPlugin(manifest, instance, config);
    }
};
exports.PluginLoaderService = PluginLoaderService;
exports.PluginLoaderService = PluginLoaderService = __decorate([
    (0, common_1.Injectable)(),
    __param(4, (0, common_1.Optional)()),
    __param(5, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [config_1.ConfigService,
        hooks_1.HookManager,
        plugin_storage_service_1.PluginStorageService,
        core_1.ModuleRef,
        lid_mapping_store_service_1.LidMappingStoreService,
        shutdown_service_1.ShutdownService])
], PluginLoaderService);
