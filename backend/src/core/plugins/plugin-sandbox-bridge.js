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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginSandboxBridge = void 0;
const path = __importStar(require("path"));
const hooks_1 = require("../hooks");
const plugin_interfaces_1 = require("./plugin.interfaces");
const plugin_activation_1 = require("./plugin-activation");
const capability_router_1 = require("./sandbox/capability-router");
const handover_gate_1 = require("./handover-gate");
const sandbox_log_meta_1 = require("./sandbox-log-meta");
const webhook_subscribe_util_1 = require("./webhook-subscribe.util");
const search_provider_registration_util_1 = require("./search-provider-registration.util");
const integration_constants_1 = require("../../modules/integration/integration.constants");
/** Time budget for a sandboxed plugin's hook handler before the chain proceeds without it. */
const SANDBOX_HOOK_TIMEOUT_MS = 5000;
/** A sandboxed plugin's healthCheck must answer within this, else it's reported unhealthy (not hung). */
const SANDBOX_HEALTH_TIMEOUT_MS = 5000;
/** A sandboxed plugin's search handler must answer within this, else /search fails fast (not hung). */
const SANDBOX_SEARCH_TIMEOUT_MS = 10000;
/**
 * A sandboxed plugin's load()/onLoad/onEnable/onDisable must complete within this, else the worker is
 * torn down and the operation fails — a wedged lifecycle can't hang the enable/disable request (and
 * the ADMIN HTTP call behind it) forever. Generous on purpose: a slow-but-valid onEnable that opens
 * connections should still finish well under it.
 */
const SANDBOX_LIFECYCLE_TIMEOUT_MS = 30000;
/**
 * Rate limit for the structured sandboxed-hook error log: at most one line per event per window so a
 * hook that throws on every message can't flood the host log. Suppressed occurrences are counted and
 * ride the next emitted line.
 */
const SANDBOX_HOOK_ERROR_LOG_INTERVAL_MS = 60000;
/**
 * Worker log-relay bounds (per sandboxed plugin): at most this many lines per window are relayed;
 * excess is dropped, counted, and surfaced as one warn per window. Longer lines are truncated. The
 * worker is not a security boundary — these are robustness bounds against a chatty/buggy plugin
 * flooding the host log, not isolation.
 */
const SANDBOX_LOG_MAX_PER_WINDOW = 200;
const SANDBOX_LOG_WINDOW_MS = 10000;
const SANDBOX_LOG_MAX_MESSAGE_LENGTH = 8192;
/**
 * The sandboxed-worker half of the plugin runtime: everything that speaks to an untrusted plugin's
 * worker thread. Spawning the host on enable (and tearing it down on disable), relaying the worker's
 * hook subscriptions, log lines and search-provider declaration back into the host, reacting to a
 * worker exit, and the health + ingress-webhook dispatch that route to a live worker.
 *
 * Split out of PluginLoaderService so the loader reads as registry + lifecycle while this IPC bridge
 * — the boundary an untrusted worker can actually poke — is reviewed on its own. A plain class, not
 * a Nest provider: the loader constructs it in its constructor with everything it needs (the same
 * pattern as PluginCapabilityContext), so the loader's public constructor signature — which specs
 * build directly — is unchanged.
 *
 * Two deliberate seams keep the uneditable specs working:
 *  - `createHost` is a closure over the loader's protected createSandboxHost, so a spec subclass that
 *    overrides that method still injects its fake/real worker host through the bridge.
 *  - `plugins`, `sandboxHosts` and `lastSandboxHookError` are the loader's own Maps, passed by
 *    reference: specs poke them on the loader via casts, and one shared (mutable) Map instance keeps
 *    the loader's view and the bridge's view the same map.
 */
class PluginSandboxBridge {
    logger;
    hookManager;
    capabilities;
    hostServices;
    configService;
    pluginStorage;
    plugins;
    sandboxHosts;
    lastSandboxHookError;
    pluginsDir;
    createHost;
    resolvePluginMainPath;
    constructor(
    // The LOADER's logger, deliberately — sandbox-bridge lines carry the PluginLoaderService tag,
    // and that context is operator-visible. Creating a second logger here would silently retag every
    // sandbox log line the moment this moved out.
    logger, hookManager, capabilities, hostServices, configService, pluginStorage, 
    // The loader's own registry + sandbox state, passed BY REFERENCE (see the class doc): mutations
    // here are visible to the loader and to the specs that poke these Maps on it.
    plugins, sandboxHosts, lastSandboxHookError, pluginsDir, 
    // Closure over the loader's protected createSandboxHost (see the class doc for the seam).
    createHost, 
    // resolvePluginMainPath stays exported from the loader (specs import it there); passed in so this
    // file never has to import back from the loader, which would close an import cycle.
    resolvePluginMainPath) {
        this.logger = logger;
        this.hookManager = hookManager;
        this.capabilities = capabilities;
        this.hostServices = hostServices;
        this.configService = configService;
        this.pluginStorage = pluginStorage;
        this.plugins = plugins;
        this.sandboxHosts = sandboxHosts;
        this.lastSandboxHookError = lastSandboxHookError;
        this.pluginsDir = pluginsDir;
        this.createHost = createHost;
        this.resolvePluginMainPath = resolvePluginMainPath;
    }
    /**
     * Surface a sandboxed plugin's hook-handler failure host-side: record it for the plugin's health
     * surface and emit one structured warn per event per SANDBOX_HOOK_ERROR_LOG_INTERVAL_MS — a hook
     * that throws on every message must be visible, but must not become a log-flood vector. Suppressed
     * occurrences are counted and ride the next emitted line.
     */
    recordSandboxHookError(pluginId, event, error, rateLimit, action = 'sandbox_hook_error') {
        this.lastSandboxHookError.set(pluginId, { event, error, at: new Date() });
        const now = Date.now();
        // Errors and timeouts are windowed apart, so a burst of one never hides the other.
        const key = `${action}:${event}`;
        const state = rateLimit.get(key);
        if (state && now - state.lastAt < SANDBOX_HOOK_ERROR_LOG_INTERVAL_MS) {
            state.suppressed++;
            return;
        }
        const suppressed = state?.suppressed ?? 0;
        rateLimit.set(key, { lastAt: now, suppressed: 0 });
        this.logger.warn(`Sandboxed plugin ${pluginId} hook '${event}' handler failed: ${error}`, {
            pluginId,
            event,
            action,
            ...(suppressed > 0 ? { suppressed } : {}),
        });
    }
    /**
     * Run a plugin's healthCheck across both tiers. A sandboxed plugin's healthCheck lives in the worker
     * (plugin.instance is null), so route to the live worker host (time-bounded); built-ins use the
     * in-process instance. A sandboxed plugin with no live worker (crashed, failed to enable, disabled) is
     * unhealthy. Returns the default "healthy" when a built-in implements no health check.
     */
    async checkPluginHealth(pluginId) {
        const sandboxHost = this.sandboxHosts.get(pluginId);
        if (sandboxHost) {
            const result = await sandboxHost.healthCheck(SANDBOX_HEALTH_TIMEOUT_MS);
            // Attach the last hook-handler error the worker reported: a plugin whose hook throws on every
            // event can still answer healthCheck "healthy" while doing nothing useful. This is operator
            // context, not a verdict override — the worker's own healthCheck stays authoritative.
            const lastError = this.lastSandboxHookError.get(pluginId);
            if (!lastError)
                return result;
            const note = `last hook error in '${lastError.event}' at ${lastError.at.toISOString()}: ${lastError.error}`;
            return { healthy: result.healthy, message: result.message ? `${result.message}; ${note}` : note };
        }
        const plugin = this.plugins.get(pluginId);
        if (plugin && !plugin.builtIn) {
            const message = plugin.status === plugin_interfaces_1.PluginStatus.ERROR && plugin.error
                ? plugin.error
                : `plugin is not running (status ${plugin.status})`;
            return { healthy: false, message };
        }
        if (plugin?.instance?.healthCheck) {
            return plugin.instance.healthCheck();
        }
        return { healthy: true, message: 'Plugin does not implement health check' };
    }
    /**
     * Dispatch a queued ingress job into its plugin's live sandbox worker. Called from IngressProcessor,
     * mirroring checkPluginHealth's sandboxHosts lookup. Throws when the plugin has no live
     * worker (disabled/crashed since the job was enqueued), when the instance was disabled or deleted
     * since, or when the worker's handler itself reports
     * failure (`!result.ok`, e.g. a 502/504/500) — either way BullMQ's retry/DLQ machinery takes over.
     */
    async dispatchWebhookForInstance(d) {
        const host = this.sandboxHosts.get(d.pluginId);
        if (!host) {
            throw new Error('no live sandbox host for plugin ' + d.pluginId);
        }
        // Resolve this instance's per-session config (the base merged with the sessionScope override that
        // provisioning wrote) so the ingress handler reads it as ctx.config — this is what makes a minted
        // instance multi-tenant. Best-effort: an unresolved plugin just yields undefined (base config only).
        const plugin = this.plugins.get(d.pluginId);
        const route = plugin?.manifest.ingress?.find(candidate => candidate.route === d.route);
        // Reaching dispatch means every authenticating scheme already passed host verification. A route
        // explicitly configured with scheme:none is unauthenticated and must never be labelled verified.
        // The verdict is the one recorded at admission: a plugin update can change the route's scheme while
        // a delivery waits, and it must not relabel a payload nobody authenticated. A delivery admitted before
        // the verdict was recorded reads the route as it stands. Missing/hot-swapped route metadata fails closed.
        const verified = !!route && (d.payload.admission?.verified ?? route.signature.scheme !== 'none');
        const instance = await this.hostServices.getPluginInstancePort().resolve(d.pluginId, d.instanceId);
        // The live door and the reconciler refuse an unknown or disabled instance; a queued job, a retry,
        // the inline fallback and a redrive all land here instead, so the same rule is enforced once more.
        // A missing row must never fall through to the base config below: a wildcard instance projects its
        // own config there, so the delivery would run with another instance's endpoint and credentials.
        // Throwing hands the job to the normal retry/dead-letter path.
        if (!instance || instance.enabled === false) {
            throw new Error('instance ' + d.instanceId + ' of plugin ' + d.pluginId + ' is disabled or deleted');
        }
        // The job carries the session the instance acted on at admission. Rebound since, the delivery would
        // reach the handler under that session with the new session's config, so it is refused instead.
        if ((0, plugin_activation_1.sessionScopeKey)(instance.sessionScope) !== (0, plugin_activation_1.sessionScopeKey)(d.sessionId)) {
            throw new Error('instance ' + d.instanceId + ' of plugin ' + d.pluginId + ' was rebound since this delivery');
        }
        // Three layers, most specific last: the base ('*') config, then the operator's per-session
        // override from PUT /plugins/:id/sessions/:sessionId/config, then THIS instance's own config.
        // The instance layer is what keeps two instances sharing one session scope apart — provisioning
        // projects both onto the same scope key, so the scope-keyed store alone would hand a delivery
        // whichever instance was provisioned last. It applies even for a non-session-scoped plugin,
        // whose instances are otherwise indistinguishable here.
        //
        // PRECEDENCE NOTE: this puts the instance row above the operator's per-session override from
        // PUT /plugins/:id/sessions/:sessionId/config, for the keys the instance itself defines. That is
        // deliberate and cannot be otherwise: provisioning PROJECTS each instance's config into the
        // scope-keyed store, so for two instances sharing a scope that slice holds whichever was written
        // last — applying it on top would hand a delivery the other tenant's credentials again. The
        // override still decides every key the instance does not define, and still decides everything on
        // the hook path. To change an instance's own config, use the instance route.
        // The scope slice is consulted only while it can be ATTRIBUTED to this instance. Layering the row
        // on top corrects the keys the row defines; every key it leaves unset — the normal shape when an
        // instance relies on a plugin default — falls through to that slice, which for two instances
        // sharing a scope holds the other tenant's projected value. So a sparse row was still handed a
        // sibling's live endpoint or token.
        //
        // KNOWN RESIDUE: a WILDCARD instance is projected into the BASE config instead
        // (scope-binding.service.ts, `updatePluginConfig`), and that merge is not separable per instance
        // by design — its own comment says so. Attribution there needs the projection re-keyed by
        // instance, which is a storage change, not a resolution one.
        const scopeIsAttributable = await this.scopeHasAtMostOneInstance(d.pluginId, instance?.sessionScope ?? undefined);
        const config = plugin
            ? (0, plugin_activation_1.resolveInstanceConfig)(scopeIsAttributable
                ? (0, plugin_activation_1.resolvePluginConfig)(plugin.config, plugin.sessionConfig, instance?.sessionScope ?? undefined, plugin.manifest.sessionScoped !== false, plugin.manifest)
                : plugin.config, instance?.config, plugin.manifest, plugin.config)
            : undefined;
        const result = await host.dispatchWebhook({
            instanceId: d.instanceId,
            route: d.route,
            method: d.method ?? 'POST',
            headers: d.payload.headers,
            query: d.payload.query,
            body: d.payload.body,
            rawBody: d.payload.rawBody,
            verified,
            deliveryId: d.deliveryId,
            sessionId: d.sessionId,
            config,
            timeoutMs: integration_constants_1.INGRESS_DISPATCH_TIMEOUT_MS,
        });
        if (!result.ok) {
            throw new Error(result.error ?? 'ingress dispatch failed with status ' + result.status);
        }
    }
    /**
     * Whether the scope-keyed config slice can be attributed to the instance being dispatched.
     *
     * Provisioning projects each instance's config into that slice keyed by SCOPE, so with siblings it
     * holds whichever was written last and says nothing about whose delivery this is. With one enabled
     * instance it is either that instance's own projection or an operator's deliberate per-session
     * override — both of which must keep applying, so a single-instance deployment is unchanged.
     *
     * A lookup failure is treated as NOT attributable: the instance's own config still applies, and the
     * cost of being wrong that way is a missing default rather than another tenant's credential.
     */
    async scopeHasAtMostOneInstance(pluginId, scope) {
        if (!scope)
            return false;
        try {
            const rows = await this.hostServices.getPluginInstancePort().list(pluginId);
            return rows.filter(row => row.enabled && row.sessionScope === scope).length <= 1;
        }
        catch (error) {
            // Logged rather than swallowed: this drops the operator's per-session override for the
            // deliveries it affects, and a silent config change is exactly what made the original
            // collapse hard to see.
            this.logger.warn('Could not count instances on the scope; withholding the per-session config slice', {
                pluginId,
                scope,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }
    /**
     * Untrusted enable: load the plugin in an isolated worker and drive its lifecycle there. Capability
     * calls and hooks round-trip to the host, which enforces permission + session scope. A failure
     * tears the worker back down.
     */
    async enableSandboxed(pluginId, plugin) {
        // A new worker generation starts from a clean slate. disablePlugin clears this too, but a crash
        // and a failed enable both end a generation WITHOUT going through disable — so clearing only
        // there let the replacement worker inherit a dead one's hook error and report it through
        // checkPluginHealth as current. Enforced here, at the one point every generation begins, rather
        // than repeated on each way a generation can end.
        this.lastSandboxHookError.delete(pluginId);
        // Containment guard: reject a manifest.main that escapes the plugin dir.
        // Anchored to the directory the package was loaded from, which is not necessarily
        // <plugins.dir>/<id>: the loader also scans the legacy plugins directory, and the worker's
        // require() of a path in the wrong tree fails with MODULE_NOT_FOUND.
        const packageDir = plugin.packageDir ?? path.join(this.pluginsDir, pluginId);
        const mainPath = this.resolvePluginMainPath(path.dirname(packageDir), path.basename(packageDir), plugin.manifest.main);
        // The capability dispatcher runs a worker request through the SAME context an in-process plugin
        // gets, so permission + session-scope checks (assertPermission / assertSessionActive) apply
        // identically. The worker can only ask; the host is the gatekeeper.
        const context = this.capabilities.createPluginContext(plugin);
        const onHookSubscribe = this.buildHookSubscribeHandler(pluginId, plugin);
        // When the worker claims an ingress route, check the claim against the manifest-declared routes
        // and log an undeclared one (warn once). Same hardening as onHookSubscribe (the wire `route` is an
        // arbitrary untrusted string). Nothing is recorded: dispatch never consults the claim, and the
        // worker answers 404 for a route it never registered.
        const onWebhookSubscribe = (0, webhook_subscribe_util_1.makeOnWebhookSubscribe)({
            pluginId,
            declaredRoutes: new Set((plugin.manifest.ingress ?? []).map(r => r.route)),
            hasPermission: (plugin.manifest.permissions ?? []).includes(plugin_interfaces_1.PluginCapabilityPermission.WEBHOOK_INGRESS),
            warn: (message, meta) => this.logger.warn(message, meta),
        });
        const logRelayState = { windowStart: Date.now(), count: 0, dropped: 0 };
        const onLog = this.buildLogRelay(pluginId, context, logRelayState);
        const onSearchProviderRegister = this.buildSearchProviderRegistrar(pluginId, plugin);
        const onWorkerExit = this.buildWorkerExitHandler(pluginId, logRelayState, () => host);
        // A worker whose event loop stays blocked after a dispatch timeout (a synchronous loop in plugin
        // code) would otherwise keep running and queue every later dispatch for the full budget each.
        // Same policy as a crash: terminate it and leave the plugin in ERROR for the operator to re-enable.
        // The generation check keeps a late report from marking a replacement worker.
        const onUnresponsive = () => {
            if (this.sandboxHosts.get(pluginId) !== host)
                return;
            this.markWorkerFailed(pluginId, 'worker unresponsive: event loop blocked past the liveness probe');
            this.logger.warn(`Sandboxed plugin ${pluginId} worker is unresponsive; terminating it`, {
                pluginId,
                action: 'sandbox_worker_unresponsive',
            });
            void host.terminate().catch(() => undefined);
        };
        const host = this.createHost((verb, args) => (0, capability_router_1.dispatchCapabilityVerb)(context, verb, args), onHookSubscribe, onWebhookSubscribe, onLog, 
        // Re-establish the in-flight hook context for worker-initiated capability calls, so a sandboxed
        // plugin that sends from within a send hook can't loop the event back into itself unboundedly.
        (events, run) => this.hookManager.runInFlight(events, run), onSearchProviderRegister, onWorkerExit, onUnresponsive);
        this.sandboxHosts.set(pluginId, host);
        // The worker keeps this config as its base until a config-change arrives, and a save made while the
        // plugin is still enabling is not pushed (it is not ENABLED yet). Every save replaces plugin.config.
        const loadedConfig = plugin.config;
        try {
            await host.load(mainPath, { pluginId, config: loadedConfig }, SANDBOX_LIFECYCLE_TIMEOUT_MS);
            await host.runLifecycle('onLoad', SANDBOX_LIFECYCLE_TIMEOUT_MS);
            await host.runLifecycle('onEnable', SANDBOX_LIFECYCLE_TIMEOUT_MS);
        }
        catch (error) {
            this.sandboxHosts.delete(pluginId);
            // Drop a search provider registered mid-onEnable before the failure: without this, a plugin that
            // registers then throws leaves a dead provider as the ACTIVE registry entry in auto mode, so every
            // /search routes to a terminated worker → outage. Mirrors disablePlugin's cleanup.
            (0, search_provider_registration_util_1.unregisterPluginSearchProvider)(this.hostServices.getSearchRegistryPort(), pluginId);
            await host.terminate().catch(() => undefined);
            throw error;
        }
        // After onEnable, never during it: the worker runs messages concurrently, so a push mid-enable would run
        // onConfigChange before onEnable finished.
        if (plugin.config !== loadedConfig)
            host.sendConfigChange(plugin.config);
    }
    /**
     * The sandboxed half of disablePlugin: the loader found a live worker host, so the plugin's
     * onDisable (and, only on the unload path, onUnload) runs in the worker, bounded, before the worker
     * is terminated and dropped from sandboxHosts. The shared tail of disablePlugin — hook
     * unregistration, the search-provider drop, status persistence — stays in the loader because it
     * runs for in-process plugins too.
     */
    async teardownSandboxed(pluginId, host, opts) {
        // Disable is a force-teardown: even if the plugin's onDisable hangs (now bounded) or throws,
        // we still kill the worker and drop the reference, so a misbehaving plugin can never block a
        // disable or leak its worker thread.
        try {
            await host.runLifecycle('onDisable', SANDBOX_LIFECYCLE_TIMEOUT_MS);
        }
        catch (error) {
            this.logger.warn(`Sandboxed plugin ${pluginId} onDisable failed during disable; terminating anyway`, {
                pluginId,
                action: 'sandbox_disable_lifecycle_failed',
                error: error instanceof Error ? error.message : String(error),
            });
        }
        if (opts?.unload) {
            // The worker is about to be terminated, so this is the ONLY chance onUnload ever gets for
            // a sandboxed plugin — after terminate the hook is unreachable, and unloadPlugin's
            // in-process call can't help (plugin.instance is null). Same bounded, best-effort policy
            // as onDisable above: a wedged/throwing onUnload must never block the teardown.
            try {
                await host.runLifecycle('onUnload', SANDBOX_LIFECYCLE_TIMEOUT_MS);
            }
            catch (error) {
                this.logger.warn(`Sandboxed plugin ${pluginId} onUnload failed during unload; terminating anyway`, {
                    pluginId,
                    action: 'sandbox_unload_lifecycle_failed',
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        await host.terminate().catch(() => undefined);
        this.sandboxHosts.delete(pluginId);
    }
    // When the worker subscribes to a hook, register a shim with the hook manager that dispatches the
    // event into the worker (time-bounded, so a wedged plugin can't stall the chain). The shim looks
    // the host up at fire time, so disabling the plugin (which removes it + unregisters hooks) stops it.
    // Harden the IPC boundary against an untrusted worker flooding the host hook registry. HookEvent is
    // a type-only union and the wire payload is an arbitrary string, so a hostile/buggy worker can post
    // 'hook-subscribe' with (a) the same event repeatedly and (b) unbounded fabricated event names
    // ('x:0','x:1',…). Without guards each call adds a live host-side registration (unbounded host-heap
    // growth + an O(n log n) re-sort). Three guards, all local to this enableSandboxed call (dropped on
    // disable): reject unknown events (bounds growth to the finite known set + drops events that can
    // never fire), dedup per event, and a belt-and-suspenders size cap.
    //
    // One shim per event runs the worker's whole chain for it, so it sits at the LOWEST priority any of
    // the worker's handlers asked for: the worker re-subscribes when a later handler lowers it, and the
    // shim moves up. Pinning it to the first handler's priority let another plugin's handler run before
    // a sandboxed handler that asked to go first (a redaction ahead of a mirror, say).
    buildHookSubscribeHandler(pluginId, plugin) {
        const subscribedEvents = new Map();
        let unknownEventWarned = false;
        return (event, rawPriority) => {
            if (!(0, hooks_1.isKnownHookEvent)(event)) {
                if (!unknownEventWarned) {
                    unknownEventWarned = true; // warn at most once per plugin so a flood isn't a log-flood vector
                    this.logger.warn(`Sandboxed plugin ${pluginId} subscribed to an unknown hook event; ignoring`, {
                        pluginId,
                        event,
                        action: 'sandbox_unknown_hook_event',
                    });
                }
                return;
            }
            const priority = (0, hooks_1.normalizeHookPriority)(rawPriority);
            const existing = subscribedEvents.get(event);
            if (existing) {
                if (priority < existing.priority) {
                    this.hookManager.setPriority(existing.hookId, priority);
                    existing.priority = priority;
                }
                return;
            }
            if (subscribedEvents.size >= hooks_1.KNOWN_HOOK_EVENTS.size)
                return; // can't exceed the known set
            // Per-event rate-limit state for the hook-error log; local to this enable call so it is dropped
            // on disable exactly like subscribedEvents.
            const hookErrorLogState = new Map();
            const hookId = this.hookManager.register(pluginId, event, async (hookCtx) => {
                const liveHost = this.sandboxHosts.get(pluginId);
                if (!liveHost)
                    return { continue: true };
                // Per-session activation gate: a session-scoped plugin only sees events for the sessions
                // it is activated for. Pass-through (don't dispatch into the worker) otherwise.
                if (!(0, plugin_activation_1.isPluginActiveForSession)(plugin.manifest.sessionScoped ?? true, plugin.activeSessions ?? ['*'], hookCtx.sessionId))
                    return { continue: true };
                // Handover gate: once a human has taken over (or closed) a conversation, the bot stops
                // seeing its inbound messages. Scoped to message:received only — every other hook event is
                // unaffected. Best-effort + fail-open: a lookup failure (or an event/mapping shape the gate
                // can't resolve) must never block a normal message from reaching the adapter.
                if (event === 'message:received') {
                    try {
                        const chatId = hookCtx.data?.chatId;
                        if (chatId && hookCtx.sessionId) {
                            const handover = await this.hostServices
                                .getConversationMappingPort()
                                .findHandoverForChat(hookCtx.sessionId, chatId);
                            if (!(0, handover_gate_1.shouldDispatchToPlugin)(handover, pluginId))
                                return { continue: true };
                        }
                    }
                    catch (error) {
                        this.logger.debug(`Handover gate lookup failed for plugin ${pluginId}; dispatching normally`, {
                            pluginId,
                            event,
                            error: error instanceof Error ? error.message : String(error),
                            action: 'handover_gate_fail_open',
                        });
                    }
                }
                return liveHost
                    .dispatchHook({
                    event,
                    data: hookCtx.data,
                    sessionId: hookCtx.sessionId,
                    source: hookCtx.source,
                    // The host resolves the per-session slice (real secrets — the worker is the plugin's
                    // trusted execution context) and ships it; the worker exposes it as ctx.config.
                    config: (0, plugin_activation_1.resolvePluginConfig)(plugin.config, plugin.sessionConfig, hookCtx.sessionId, plugin.manifest.sessionScoped !== false, plugin.manifest),
                    // The chain this dispatch belongs to, so a capability the handler calls is guarded
                    // against re-firing any event of it (not only this one) once it returns to the host.
                    inFlight: this.hookManager.currentInFlight(),
                    timeoutMs: SANDBOX_HOOK_TIMEOUT_MS,
                    // Rate-limited like a handler error: a plugin that times out on every message must be
                    // visible (log + health) without writing one line per event.
                    onTimeout: () => this.recordSandboxHookError(pluginId, event, `timed out after ${SANDBOX_HOOK_TIMEOUT_MS}ms`, hookErrorLogState, 'sandbox_hook_timeout'),
                })
                    .then(result => {
                    // The worker reports (not throws) a hook-handler failure: surface it host-side instead
                    // of failing open in silence. The chain itself still proceeds fail-open.
                    if (result.error)
                        this.recordSandboxHookError(pluginId, event, result.error, hookErrorLogState);
                    return { continue: result.continue, data: result.data };
                });
            }, priority);
            subscribedEvents.set(event, { hookId, priority });
        };
    }
    // Route the worker plugin's ctx.logger.* calls to the same per-plugin logger an in-process plugin
    // uses, so sandboxed plugins log identically (prefixed + structured) instead of bare stdout. The
    // relay is bounded: oversized lines are truncated and throughput is capped per window — a chatty
    // or buggy plugin must not flood the host log. Dropped lines are counted and surfaced as one warn
    // per window (never one line per drop, or the bound itself would be a flood vector), plus a final
    // flush on worker exit so a plugin that goes quiet first doesn't silently lose the count. State is
    // local to this enable call, so it resets on disable.
    buildLogRelay(pluginId, context, state) {
        return (level, message, meta) => {
            const now = Date.now();
            if (now - state.windowStart >= SANDBOX_LOG_WINDOW_MS) {
                if (state.dropped > 0) {
                    this.logger.warn(`Dropped ${state.dropped} log messages from sandboxed plugin ${pluginId} (log relay rate limit)`, { pluginId, action: 'sandbox_log_relay_dropped', dropped: state.dropped });
                }
                state.windowStart = now;
                state.count = 0;
                state.dropped = 0;
            }
            state.count++;
            if (state.count > SANDBOX_LOG_MAX_PER_WINDOW) {
                state.dropped++;
                return;
            }
            // Like the level below, the message and meta come off the wire unchecked: a non-string message is replaced by
            // a fixed marker (turning an array into text would write a shared reference out at every use), and a meta
            // whose text, as the logger writes it (metaText), exceeds the same cap is replaced by a size marker (not a
            // truncated string, which would hide its keys from the logger's secret redaction).
            // logger.error's reason travels as a string meta.error, so that one key survives the replacement.
            const truncate = (value) => value.length > SANDBOX_LOG_MAX_MESSAGE_LENGTH
                ? `${value.slice(0, SANDBOX_LOG_MAX_MESSAGE_LENGTH)}…[truncated]`
                : value;
            const bounded = truncate(typeof message === 'string' ? message : '[non-string log message]');
            let boundedMeta = meta;
            if (meta !== undefined) {
                const reason = typeof meta?.error === 'string' ? { error: truncate(meta.error) } : undefined;
                // A count past the size limit (values, string characters and property name characters) marks a meta that is
                // replaced without being written out. The text is only built, to learn its length, for a meta under the
                // limit: building it for any other could take seconds, as a shared reference is written out at every use.
                if ((0, sandbox_log_meta_1.countMetaValues)(meta, SANDBOX_LOG_MAX_MESSAGE_LENGTH) > SANDBOX_LOG_MAX_MESSAGE_LENGTH) {
                    boundedMeta = { ...reason, metaTruncated: true };
                }
                else {
                    try {
                        const metaLength = ((0, sandbox_log_meta_1.metaText)(meta) ?? '').length;
                        if (metaLength > SANDBOX_LOG_MAX_MESSAGE_LENGTH)
                            boundedMeta = { ...reason, metaTruncated: true, metaLength };
                    }
                    catch {
                        boundedMeta = reason; // circular, or holding a BigInt, whose text is not built on the host
                    }
                }
            }
            // The level comes off the wire unchecked (plugin code can post to parentPort directly), and the
            // plugin logger has no method for anything outside PluginLogLevel.
            if (level === 'error')
                context.logger.error(bounded, undefined, boundedMeta);
            else if (level === 'debug' || level === 'warn')
                context.logger[level](bounded, boundedMeta);
            else
                context.logger.log(bounded, boundedMeta);
        };
    }
    // When the worker declares itself a search provider (ctx.registerSearchProvider →
    // search-provider-register), register a PluginSearchProvider in the SearchProviderRegistry. The host
    // is in sandboxHosts by the time registration fires (during onLoad/onEnable), so look it up lazily
    // like onHookSubscribe. Search disabled (no registry, or SEARCH_PROVIDER=none) → the util skips, and
    // a manifest without 'search:provide' is denied there — the wire declaration is untrusted input, and
    // this bridge bypasses the capability router that gates the ctx.* capabilities.
    buildSearchProviderRegistrar(pluginId, plugin) {
        return () => {
            const liveHost = this.sandboxHosts.get(pluginId);
            if (!liveHost)
                return;
            (0, search_provider_registration_util_1.registerPluginSearchProvider)({
                pluginId,
                label: `${plugin.manifest.name} (plugin)`,
                transport: liveHost,
                timeoutMs: SANDBOX_SEARCH_TIMEOUT_MS,
                registry: this.hostServices.getSearchRegistryPort(),
                mode: this.configService.get('search.provider', 'auto'),
                hasPermission: (plugin.manifest.permissions ?? []).includes(plugin_interfaces_1.PluginCapabilityPermission.SEARCH_PROVIDE),
                warn: (message, meta) => this.logger.warn(message, meta),
            });
        };
    }
    // Shared ERROR transition for a crashed or unresponsive worker: mark the plugin ERROR, drop its hook
    // shims and the dead host. The exit handler releases the search provider.
    markWorkerFailed(pluginId, reason) {
        const plugin = this.plugins.get(pluginId);
        if (plugin) {
            plugin.status = plugin_interfaces_1.PluginStatus.ERROR;
            plugin.error = reason;
            this.pluginStorage.setPluginStatus(pluginId, plugin_interfaces_1.PluginStatus.ERROR);
        }
        this.hookManager.unregisterPlugin(pluginId);
        this.sandboxHosts.delete(pluginId);
    }
    // A worker that crashes AFTER a successful enable is otherwise invisible to the loader (handleExit only
    // drains in-flight calls). Drop the plugin's search-provider entry so the registry falls back to
    // builtin-fts instead of routing every /search to a dead worker (auto mode would otherwise pin the dead
    // provider ACTIVE). Mirrors the enable-failure cleanup.
    buildWorkerExitHandler(pluginId, logRelayState, getSourceHost) {
        return (code, intentional, reason) => {
            // Final log-relay flush: the per-window drop warn above only fires when a new line arrives in a
            // later window, so without this a plugin that goes quiet (or is disabled) before the rollover
            // silently discards its pending count. The worker is gone, so no further lines can arrive.
            if (logRelayState.dropped > 0) {
                this.logger.warn(`Dropped ${logRelayState.dropped} log messages from sandboxed plugin ${pluginId} (log relay rate limit)`, { pluginId, action: 'sandbox_log_relay_dropped', dropped: logRelayState.dropped });
                logRelayState.dropped = 0;
            }
            // A replacement owns its provider, hooks and status. An absent host still needs cleanup after
            // markWorkerFailed removed the retiring worker before its termination completed.
            const currentHost = this.sandboxHosts.get(pluginId);
            if (currentHost && currentHost !== getSourceHost())
                return;
            (0, search_provider_registration_util_1.unregisterPluginSearchProvider)(this.hostServices.getSearchRegistryPort(), pluginId);
            if (intentional)
                return; // routine disable/enable-failure already logged and expected
            // Unexpected crash after a successful enable: the worker is gone. Drop the dead host +
            // unregister the hook shims (so they don't keep dispatching into the dead worker) + mark the
            // plugin ERROR so the dashboard reflects reality. The dispatchHook/dispatchWebhook dead-checks
            // fail-fast; this cleanup is the root-cause fix (it also makes the shim's !liveHost guard fire).
            const why = reason ? `: ${reason}` : '';
            this.markWorkerFailed(pluginId, `worker exited unexpectedly (code ${code})${why}`);
            this.logger.warn(`Sandboxed plugin ${pluginId} worker exited unexpectedly (code ${code})${why}`, {
                pluginId,
                code,
                action: 'sandbox_worker_exit',
            });
        };
    }
}
exports.PluginSandboxBridge = PluginSandboxBridge;
