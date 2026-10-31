"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginLifecycle = void 0;
const plugin_interfaces_1 = require("./plugin.interfaces");
const search_provider_registration_util_1 = require("./search-provider-registration.util");
const plugin_paths_1 = require("./plugin-paths");
const plugin_uninstaller_1 = require("./plugin-uninstaller");
/**
 * The runtime half of the plugin loader: everything that happens to a plugin AFTER the boot scan has
 * registered it — enable/disable/unload (routing untrusted plugins into the sandbox bridge, trusted
 * built-ins in-process), operator config and per-session activation writes, and programmatic
 * built-in registration.
 *
 * Split out of PluginLoaderService so the loader reads as the public facade while the lifecycle
 * state machine — status transitions, the enable concurrency lock, failure cleanup — is reviewed on
 * its own. A plain class, not a Nest provider: the loader constructs it in its constructor (the same
 * pattern as PluginSandboxBridge / PluginCapabilityContext), so the loader's public constructor
 * signature — which specs build directly — is unchanged.
 */
class PluginLifecycle {
    logger;
    configService;
    hookManager;
    pluginStorage;
    capabilities;
    sandboxBridge;
    hostServices;
    ensureRegistryEntry;
    plugins;
    sandboxHosts;
    lastSandboxHookError;
    pluginsDir;
    /** Plugin ids whose enable() is in flight — a synchronous lock so concurrent enables can't double-run. */
    enabling = new Set();
    /** In-flight disables by plugin id, so a concurrent disable joins the running teardown. */
    disabling = new Map();
    constructor(
    // The LOADER's logger, deliberately — lifecycle lines carry the PluginLoaderService tag, and
    // that context is operator-visible. Creating a second logger here would silently retag every
    // enable/disable log line the moment this moved.
    logger, configService, hookManager, pluginStorage, 
    /** Owns the capability surface handed to plugins — permissions, session scope, engine resolution. */
    capabilities, 
    /** Owns the sandboxed-worker IPC bridge — enable/teardown, hook/log relay, health + webhook dispatch. */
    sandboxBridge, 
    /** Resolves the host service ports; see PluginHostServices for why it is not constructor-injected. */
    hostServices, 
    /** The scanner's registry-entry writer, for programmatic built-in registration. */
    ensureRegistryEntry, 
    // The LOADER's registry + sandbox state, passed BY REFERENCE (see the class doc): mutations here
    // are visible to the loader, the bridge, and to the specs that poke these Maps on the loader.
    plugins, sandboxHosts, lastSandboxHookError, pluginsDir) {
        this.logger = logger;
        this.configService = configService;
        this.hookManager = hookManager;
        this.pluginStorage = pluginStorage;
        this.capabilities = capabilities;
        this.sandboxBridge = sandboxBridge;
        this.hostServices = hostServices;
        this.ensureRegistryEntry = ensureRegistryEntry;
        this.plugins = plugins;
        this.sandboxHosts = sandboxHosts;
        this.lastSandboxHookError = lastSandboxHookError;
        this.pluginsDir = pluginsDir;
    }
    async enablePlugin(pluginId) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin) {
            throw new Error(`Plugin ${pluginId} not found`);
        }
        if (plugin.status === plugin_interfaces_1.PluginStatus.ENABLED) {
            return; // Already enabled
        }
        // Engines are mutually exclusive and pinned to the deployment's engine.type config (the factory
        // reads that, not plugin status). Enabling a second engine at runtime would show two "active"
        // engines and desync the factory, so reject anything but the configured active engine.
        if (plugin.manifest.type === plugin_interfaces_1.PluginType.ENGINE) {
            const activeEngine = this.configService.get('engine.type') ?? 'whatsapp-web.js';
            if (pluginId !== activeEngine) {
                throw new Error(`Engine "${pluginId}" is not the active engine ("${activeEngine}"). Set engine.type and restart to switch engines.`);
            }
        }
        // Concurrency guard: status flips to ENABLED only AFTER the awaits below, so two concurrent enable
        // calls would both pass the check above, both run onEnable, and both register the plugin's hooks
        // (duplicate side effects). Claim the enable synchronously here so a racing caller is rejected
        // before any await; released in finally.
        if (this.enabling.has(pluginId)) {
            throw new Error(`Plugin ${pluginId} is already being enabled`);
        }
        this.enabling.add(pluginId);
        try {
            if (plugin.builtIn === false) {
                await this.sandboxBridge.enableSandboxed(pluginId, plugin);
            }
            else {
                await this.enableInProcess(pluginId, plugin);
            }
            plugin.status = plugin_interfaces_1.PluginStatus.ENABLED;
            plugin.enabledAt = new Date();
            plugin.error = undefined;
            // Persist status
            this.pluginStorage.setPluginStatus(pluginId, plugin_interfaces_1.PluginStatus.ENABLED);
            this.logger.log(`Plugin enabled: ${plugin.manifest.name}`, {
                pluginId,
                action: 'plugin_enabled',
            });
        }
        catch (error) {
            plugin.status = plugin_interfaces_1.PluginStatus.ERROR;
            plugin.error = error instanceof Error ? error.message : String(error);
            this.pluginStorage.setPluginStatus(pluginId, plugin_interfaces_1.PluginStatus.ERROR);
            // A plugin that subscribed hooks before its onLoad/onEnable threw would otherwise leave those
            // registrations live: a later successful enable re-registers them, so each event then dispatches
            // to the plugin once per failed attempt. Drop them here. Safe on this path only — an
            // already-enabled plugin returns early above, so the catch only runs for an enable that never
            // went live, which owns no hooks worth keeping. (Idempotent: no-ops when none were registered.)
            this.hookManager.unregisterPlugin(pluginId);
            throw error;
        }
        finally {
            this.enabling.delete(pluginId);
        }
    }
    /**
     * Disable an enabled plugin (best-effort force-teardown for sandboxed ones). `opts.unload` is set
     * ONLY by the unload path (uninstall / in-place update): it additionally dispatches the plugin's
     * onUnload hook. A plain disable (REST / shutdown teardown) deliberately does NOT fire onUnload —
     * disable is reversible and its cleanup hook is onDisable, while onUnload means "removed from the
     * runtime". (For a sandboxed plugin the worker thread does die on disable, but terminate() itself
     * releases its timers/sockets; the hook contract stays: onUnload only on unload.)
     */
    async disablePlugin(pluginId, opts) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin) {
            throw new Error(`Plugin ${pluginId} not found`);
        }
        if (plugin.status !== plugin_interfaces_1.PluginStatus.ENABLED) {
            return; // Not enabled
        }
        // Status flips to DISABLED only after the teardown awaits, so a second disable arriving meanwhile
        // (shutdown overlapping a REST disable, an uninstall or an update unload) would pass the check
        // above and run onDisable again. Join the teardown already in flight instead. An unload that joins a plain
        // disable of a sandboxed plugin gets no onUnload, the same as unloading one already disabled.
        const inFlight = this.disabling.get(pluginId);
        if (inFlight) {
            return inFlight;
        }
        const disabling = this.teardown(pluginId, plugin, opts).finally(() => this.disabling.delete(pluginId));
        this.disabling.set(pluginId, disabling);
        return disabling;
    }
    async teardown(pluginId, plugin, opts) {
        try {
            const host = this.sandboxHosts.get(pluginId);
            if (host) {
                await this.sandboxBridge.teardownSandboxed(pluginId, host, opts);
            }
            else {
                const context = this.capabilities.createPluginContext(plugin);
                if (plugin.instance?.onDisable) {
                    await plugin.instance.onDisable(context);
                }
            }
            // Unregister all hooks for this plugin
            this.hookManager.unregisterPlugin(pluginId);
            // Drop the plugin's search-provider entry (if any) so queries don't route to a terminated worker.
            (0, search_provider_registration_util_1.unregisterPluginSearchProvider)(this.hostServices.getSearchRegistryPort(), pluginId);
            plugin.status = plugin_interfaces_1.PluginStatus.DISABLED;
            this.pluginStorage.setPluginStatus(pluginId, plugin_interfaces_1.PluginStatus.DISABLED);
            // A fresh enable starts with a clean hook-error slate (the state is per runtime, not persisted).
            this.lastSandboxHookError.delete(pluginId);
            this.logger.log(`Plugin disabled: ${plugin.manifest.name}`, {
                pluginId,
                action: 'plugin_disabled',
            });
        }
        catch (error) {
            plugin.status = plugin_interfaces_1.PluginStatus.ERROR;
            plugin.error = error instanceof Error ? error.message : String(error);
            throw error;
        }
    }
    async unloadPlugin(pluginId) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin) {
            throw new Error(`Plugin ${pluginId} not found`);
        }
        // Disable first if enabled. `unload: true` so a SANDBOXED plugin also gets its onUnload hook:
        // disable terminates the worker thread, which would otherwise make onUnload unreachable. An
        // in-process plugin's onUnload runs below instead (its instance survives disable). A sandboxed
        // plugin that is already disabled has no live worker left to notify — its resources were
        // released when the worker terminated, so there is nothing to clean up.
        if (plugin.status === plugin_interfaces_1.PluginStatus.ENABLED) {
            await this.disablePlugin(pluginId, { unload: true });
        }
        // Call onUnload (in-process plugins; a sandboxed one received it above, before terminate)
        if (plugin.instance?.onUnload) {
            const context = this.capabilities.createPluginContext(plugin);
            await plugin.instance.onUnload(context);
        }
        this.plugins.delete(pluginId);
        this.logger.log(`Plugin unloaded: ${plugin.manifest.name}`, {
            pluginId,
            action: 'plugin_unloaded',
        });
    }
    updatePluginConfig(pluginId, config, opts) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin) {
            throw new Error(`Plugin ${pluginId} not found`);
        }
        (0, plugin_uninstaller_1.assertNotUninstalling)(pluginId, plugin);
        // Persist only the operator's keys on top of what was persisted before, not the effective merge:
        // a built-in's effective config carries its env-derived defaults, and storing those would freeze
        // them over later .env changes (see registerBuiltInPlugin). Persisted first: a write that must be stored
        // and cannot be throws here and leaves the running config as it was.
        this.pluginStorage.setPluginConfig(pluginId, {
            ...(this.pluginStorage.getPluginConfig(pluginId) ?? {}),
            ...config,
        }, opts);
        plugin.config = { ...plugin.config, ...config };
        // Notify the running plugin of the config change (fire and forget). A sandboxed plugin's
        // onConfigChange lives in the worker (plugin.instance is null), so route it through the live worker
        // host so it refreshes ctx.config too; built-ins go through the in-process instance.
        if (plugin.status === plugin_interfaces_1.PluginStatus.ENABLED) {
            const sandboxHost = this.sandboxHosts.get(pluginId);
            if (sandboxHost) {
                sandboxHost.sendConfigChange(plugin.config);
            }
            else if (plugin.instance?.onConfigChange) {
                const context = this.capabilities.createPluginContext(plugin);
                void plugin.instance.onConfigChange(context, plugin.config);
            }
        }
        this.logger.debug(`Plugin config updated: ${pluginId}`, {
            pluginId,
            action: 'plugin_config_updated',
        });
    }
    /**
     * Set the sessions a session-scoped plugin is activated for. `['*']` = all numbers (system-wide),
     * an explicit list scopes it to those sessions, `[]` deactivates it everywhere. Takes effect on the
     * next hook event (the gate reads plugin.activeSessions live) and survives a restart.
     */
    setPluginSessions(pluginId, sessions, opts) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin) {
            throw new Error(`Plugin ${pluginId} not found`);
        }
        (0, plugin_uninstaller_1.assertNotUninstalling)(pluginId, plugin);
        if (plugin.manifest.sessionScoped === false) {
            throw new Error(`Plugin ${pluginId} is global (not session-scoped) and cannot be activated per session`);
        }
        this.pluginStorage.setPluginSessions(pluginId, sessions, opts);
        plugin.activeSessions = sessions;
        this.logger.log(`Plugin active sessions updated: ${pluginId}`, {
            pluginId,
            action: 'plugin_sessions_updated',
            sessions,
        });
        return plugin;
    }
    /**
     * Set (or clear) a plugin's per-session config override for `sessionId`. Hooks for that session then
     * see the override deep-merged over the base via ctx.config (nested objects merge key by key; arrays
     * and scalars replace), applied on the next event (resolution reads plugin.sessionConfig live) and
     * persisted across restart. An empty override removes it (the session falls back to the base).
     * Global plugins have no per-session config.
     */
    setPluginSessionConfig(pluginId, sessionId, config, opts) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin) {
            throw new Error(`Plugin ${pluginId} not found`);
        }
        (0, plugin_uninstaller_1.assertNotUninstalling)(pluginId, plugin);
        if (plugin.manifest.sessionScoped === false) {
            throw new Error(`Plugin ${pluginId} is global (not session-scoped) and has no per-session config`);
        }
        const next = { ...(plugin.sessionConfig ?? {}) };
        if (config && Object.keys(config).length > 0) {
            next[sessionId] = config;
        }
        else {
            delete next[sessionId];
        }
        this.pluginStorage.setPluginSessionConfig(pluginId, next, opts);
        plugin.sessionConfig = next;
        this.logger.debug(`Plugin session config updated: ${pluginId}`, {
            pluginId,
            action: 'plugin_session_config_updated',
            sessionId,
        });
        return plugin;
    }
    /** Built-in (trusted) enable: require + run the lifecycle in-process with the live capability context. */
    async enableInProcess(pluginId, plugin) {
        const context = this.capabilities.createPluginContext(plugin);
        if (!plugin.instance) {
            // Containment guard: reject a manifest.main that escapes the plugin dir.
            // The configured root, not the package dir: this tier runs only for built-ins
            // (enablePlugin routes `builtIn === false` to the sandbox), and a built-in is registered
            // programmatically with no on-disk package, so the two resolve identically here.
            const mainPath = (0, plugin_paths_1.resolvePluginMainPath)(this.pluginsDir, pluginId, plugin.manifest.main);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const pluginModule = require(mainPath);
            if (pluginModule.default) {
                plugin.instance = new pluginModule.default();
            }
            else {
                throw new Error(`Plugin ${pluginId} does not export a default class`);
            }
        }
        if (plugin.instance.onLoad) {
            await plugin.instance.onLoad(context);
        }
        if (plugin.instance.onEnable) {
            await plugin.instance.onEnable(context);
        }
    }
    registerBuiltInPlugin(manifest, instance, config = {}) {
        // Merge: env-derived defaults stay live each boot (so a changed .env wins), while an operator's
        // persisted overrides win for the keys they actually set. Engine plugin config can carry such an
        // override too (PUT /api/plugins/:id/config), except the auth-dir bases, which EngineFactory
        // passes to every createEngine call from the env config.
        const effectiveConfig = { ...config, ...(this.pluginStorage.getPluginConfig(manifest.id) ?? {}) };
        const pluginInstance = {
            manifest,
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: effectiveConfig,
            instance,
            loadedAt: new Date(),
            builtIn: true,
            // Read persisted per-session activation + config back into the runtime, like loadPlugin —
            // otherwise the delivery gate falls back to all-sessions/base-config after every restart for a
            // session-scoped built-in the operator had restricted.
            activeSessions: this.pluginStorage.getPluginSessions(manifest.id) ?? undefined,
            sessionConfig: this.pluginStorage.getPluginSessionConfig(manifest.id) ?? undefined,
        };
        this.plugins.set(manifest.id, pluginInstance);
        // Ensure a registry entry exists so later enable/disable/config writes persist.
        this.ensureRegistryEntry(manifest, true);
        this.logger.debug(`Built-in plugin registered: ${manifest.name}`, {
            pluginId: manifest.id,
            action: 'builtin_plugin_registered',
        });
    }
}
exports.PluginLifecycle = PluginLifecycle;
