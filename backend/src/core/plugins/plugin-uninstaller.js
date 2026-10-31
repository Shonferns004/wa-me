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
exports.PluginUninstaller = exports.PluginUninstallIncompleteError = exports.PluginUninstallingError = void 0;
exports.assertNotUninstalling = assertNotUninstalling;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const plugin_storage_service_1 = require("./plugin-storage.service");
/** Loaded plugins an uninstall is unloading, by runtime record (one per loader, so specs never share a mark). */
const uninstalling = new WeakSet();
/** A config or session-activation write refused because an uninstall is removing the plugin. */
class PluginUninstallingError extends Error {
    constructor(pluginId) {
        super(`Plugin ${pluginId} is being uninstalled; the change was not applied`);
        this.name = 'PluginUninstallingError';
    }
}
exports.PluginUninstallingError = PluginUninstallingError;
/**
 * An uninstall that failed after it stored the plugin's registry entry emptied of config, session activation and the
 * enable decision: unlike a refusal, it changed the plugin. The message is the failure's own.
 */
class PluginUninstallIncompleteError extends Error {
    constructor(cause) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.name = 'PluginUninstallIncompleteError';
    }
}
exports.PluginUninstallIncompleteError = PluginUninstallIncompleteError;
/**
 * Refuse an operator-settings write to a plugin an uninstall is unloading: it would be stored over the entry the
 * uninstall has just emptied, and outlive the uninstall in an entry the final delete fails to drop.
 */
function assertNotUninstalling(pluginId, plugin) {
    if (uninstalling.has(plugin))
        throw new PluginUninstallingError(pluginId);
}
/**
 * The uninstall half of the plugin loader: fully remove an installed user plugin — disable + unload
 * from the runtime, delete its directories from disk, then drop its persisted registry entry. Install,
 * download and unpack live feature-side (modules/plugins); this is the runtime-owned removal they and
 * the REST surface call through PluginLoaderService.
 *
 * Split out of PluginLoaderService so the loader reads as the public facade while the removal
 * contract — package-dir provenance, the traversal guard, split-dir storage cleanup — is reviewed on
 * its own. A plain class, not a Nest provider: the loader constructs it in its constructor (the same
 * pattern as PluginSandboxBridge / PluginCapabilityContext), so the loader's public constructor
 * signature — which specs build directly — is unchanged.
 */
class PluginUninstaller {
    logger;
    plugins;
    pluginStorage;
    pluginsDir;
    unload;
    legacyPluginsDir;
    releaseTakeovers;
    constructor(
    // The LOADER's logger, deliberately — uninstall lines carry the PluginLoaderService tag, and
    // that context is operator-visible. Creating a second logger here would silently retag every
    // uninstall log line the moment this moved.
    logger, 
    // The LOADER's plugin registry, passed BY REFERENCE (see the class doc): reads here see the same
    // map the loader, the scanner and the bridge share.
    plugins, pluginStorage, pluginsDir, 
    /** The lifecycle's unload — passed as a callback so this file never imports the lifecycle back. */
    unload, 
    /** The legacy plugin tree the boot scan also loads from, or null when PLUGINS_DIR is set. */
    legacyPluginsDir = null, 
    /** Hands the chats the plugin took over back to the bot; the conversation store is not this file's. */
    releaseTakeovers) {
        this.logger = logger;
        this.plugins = plugins;
        this.pluginStorage = pluginStorage;
        this.pluginsDir = pluginsDir;
        this.unload = unload;
        this.legacyPluginsDir = legacyPluginsDir;
        this.releaseTakeovers = releaseTakeovers;
    }
    /**
     * Package folders of plugins whose uninstall stopped after the unload dropped their runtime record,
     * until a repeat completes: without it the repeat only has the id to go by, and a package whose folder
     * is not its manifest id would be left on disk to load again on the next boot.
     */
    unloadedDirs = new Map();
    /** <root>/<id> for an id with no loaded package, or null if the id escapes that root. */
    resolveUninstallDir(root, pluginId) {
        const base = path.resolve(root);
        const dir = path.resolve(base, pluginId);
        return dir !== base && dir.startsWith(base + path.sep) ? dir : null;
    }
    /**
     * Fully remove an installed user plugin: disable + unload from the runtime, delete its directory from
     * disk, then drop its persisted registry entry (last, so a failed removal can be repeated). Built-ins (engines, bundled extensions) are
     * registered programmatically with no on-disk dir and must never be removable. `registryEntryKept` is true when
     * everything else was removed but registry.json could not be written, leaving the emptied entry. A failure after
     * the emptied entry was stored rejects with {@link PluginUninstallIncompleteError}, carrying the failure's message.
     */
    async uninstallPlugin(pluginId) {
        if (this.pluginStorage.getPluginEntry(pluginId)?.builtIn) {
            throw new Error(`Cannot uninstall built-in plugin ${pluginId}`);
        }
        // Stored before anything is removed, and refusing the uninstall when it cannot be: an entry the final delete
        // fails to drop then holds nothing a reinstall of the id would inherit or a restart would enable again, and a
        // removal that stops part-way leaves a package that boots disabled and unconfigured.
        this.pluginStorage.clearOperatorSettings(pluginId, { mustPersist: true });
        try {
            return await this.removeEmptied(pluginId);
        }
        catch (error) {
            throw new PluginUninstallIncompleteError(error);
        }
    }
    /** The removal after the entry is stored emptied: from here on a failure has already erased the settings. */
    async removeEmptied(pluginId) {
        // Read the package location BEFORE unloading: unloadPlugin drops the runtime record that holds
        // it, and for a plugin loaded from the legacy directory the configured root is the wrong tree —
        // deleting there removes the ctx.storage directory and leaves the code, so the plugin comes
        // back on the next boot having reported a successful uninstall.
        const recordedDir = this.plugins.get(pluginId)?.packageDir ?? this.unloadedDirs.get(pluginId) ?? null;
        if (recordedDir)
            this.unloadedDirs.set(pluginId, recordedDir);
        // The unload awaits the plugin's own hooks with the record still loaded: no config or session write may land
        // over the emptied entry meanwhile. Once the record is gone every such write is refused as not found.
        const loaded = this.plugins.get(pluginId);
        if (loaded) {
            uninstalling.add(loaded);
            try {
                await this.unload(pluginId);
            }
            finally {
                uninstalling.delete(loaded);
            }
        }
        // A takeover the plugin held keeps every other plugin silent on that chat, and nothing is left to
        // hand it back once the plugin is gone. Done after the unload, because until its worker ends the
        // plugin can still take a chat over again, and before the registry entry goes: a store that cannot
        // take the release fails the uninstall, and a repeat finds no runtime and goes straight to it.
        await this.releaseTakeovers?.(pluginId);
        // A recorded directory came from the boot scan and is already contained. Without one the id is
        // the only input, so it stays behind the traversal guard against the configured root.
        const dir = recordedDir ?? this.resolveUninstallDir(this.pluginsDir, pluginId);
        if (dir && fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        // The legacy tree can still hold a copy the scan would load again on the next boot (as a new
        // plugin, config lost): the package of a plugin that failed to load (its registry entry survives
        // the boot scan but no runtime record does), or a copy the scan skipped as a duplicate because
        // the same id loaded from the configured tree. When the recorded dir was the legacy copy it is
        // already gone above, and this is a no-op.
        if (this.legacyPluginsDir) {
            const legacyDir = this.resolveUninstallDir(this.legacyPluginsDir, pluginId);
            if (legacyDir && fs.existsSync(path.join(legacyDir, 'manifest.json'))) {
                fs.rmSync(legacyDir, { recursive: true, force: true });
            }
        }
        // Drop the plugin's ctx.storage data dir. Under shipped defaults it lives INSIDE the package
        // dir (already gone above), but a split-dir deployment (PLUGINS_DIR outside the data dir) would
        // otherwise leak <dataDir>/plugins/<id> — persisted secrets included — on every uninstall.
        // Strictly that one plugin's directory.
        this.pluginStorage.deletePluginData(pluginId);
        // Last, so a removal that failed above leaves the entry in place: the service answers a repeat only
        // for an id it still knows, and without the entry a half-removed package would load again on the
        // next boot as a new plugin with no way left to uninstall it.
        let registryEntryKept = false;
        try {
            this.pluginStorage.deletePluginEntry(pluginId);
        }
        catch (error) {
            if (!(error instanceof plugin_storage_service_1.PluginRegistryWriteError))
                throw error;
            // The plugin is gone by now, so this no longer fails the uninstall. The entry stays, emptied before the
            // removal began; no operator write reached it since (refused during the unload, not found after), so the
            // clear below only re-asserts that in memory. No boot prunes the entry (it is only reported as a plugin
            // without code), and repeating the uninstall removes it.
            this.pluginStorage.clearOperatorSettings(pluginId);
            registryEntryKept = true;
            this.logger.warn(`Plugin ${pluginId} uninstalled, but its registry entry could not be removed`, {
                pluginId,
                action: 'plugin_uninstall_registry_entry_kept',
            });
        }
        this.unloadedDirs.delete(pluginId);
        this.logger.log(`Plugin uninstalled: ${pluginId}`, { pluginId, action: 'plugin_uninstalled' });
        return { registryEntryKept };
    }
}
exports.PluginUninstaller = PluginUninstaller;
