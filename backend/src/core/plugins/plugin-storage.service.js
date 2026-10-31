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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginStorageService = exports.PluginRegistryWriteError = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const configuration_1 = require("../../config/configuration");
const logger_service_1 = require("../../common/services/logger.service");
const path_safety_1 = require("../../common/utils/path-safety");
/** Unique-per-write counter so concurrent writes to the same key don't collide on the temp file. */
let tmpWriteSeq = 0;
/**
 * Write to a sibling temp file then atomically rename it into place. POSIX rename is atomic on the
 * same filesystem, so a crash (SIGKILL/OOM) mid-write can never leave a truncated/corrupt target —
 * a reader sees either the old complete file or the new complete file, never a partial one.
 */
function atomicWriteFileSync(filePath, data, options) {
    const tmp = `${filePath}.${process.pid}.${tmpWriteSeq++}.tmp`;
    try {
        fs.writeFileSync(tmp, data, options);
        fs.renameSync(tmp, filePath);
    }
    catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            /* best-effort temp cleanup */
        }
        throw err;
    }
}
const ENCODED_KEY_PREFIX = 'key-';
/**
 * Thrown by a registry write that had to reach the disk and could not. The change is not applied: the
 * in-memory entry is put back, so a restart cannot undo what the caller was told had been stored.
 */
class PluginRegistryWriteError extends Error {
    constructor(cause) {
        const code = cause?.code;
        super(`The plugin registry could not be written${code ? ` (${code})` : ''}; the change was not applied`);
        this.name = 'PluginRegistryWriteError';
    }
}
exports.PluginRegistryWriteError = PluginRegistryWriteError;
/**
 * Default per-plugin bound on ctx.storage writes (plugins.storageMaxBytes / PLUGIN_STORAGE_MAX_BYTES
 * overrides). The worker is not a security boundary, but an unbounded storage.set loop would still
 * fill the host disk — this is a robustness quota, not isolation.
 */
const DEFAULT_MAX_PLUGIN_STORAGE_BYTES = 50 * 1024 * 1024;
function encodeStorageKey(key) {
    return (ENCODED_KEY_PREFIX +
        Buffer.from(key, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''));
}
function decodeStorageFileName(stem) {
    if (!stem.startsWith(ENCODED_KEY_PREFIX))
        return null;
    const encoded = stem.slice(ENCODED_KEY_PREFIX.length);
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4);
    try {
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        // Only accept it as one of our base64url-encoded names if it round-trips exactly. A literal legacy
        // filename that merely starts with `key-` would otherwise be mis-decoded into a garbage key.
        return encodeStorageKey(decoded) === stem ? decoded : null;
    }
    catch {
        return null;
    }
}
let PluginStorageService = class PluginStorageService {
    configService;
    logger = (0, logger_service_1.createLogger)('PluginStorageService');
    dataDir;
    registryPath;
    maxPluginStorageBytes;
    /** Bytes in each plugin's encoded key files, once a write or delete has seeded it. See assertStorageQuota. */
    storageUsage = new Map();
    registry = new Map();
    constructor(configService) {
        this.configService = configService;
        // Same constant the `dataDir` key is built from, so this fallback (hit only by a ConfigService
        // that carries no app config, e.g. in unit tests) can never drift from the configured value.
        this.dataDir = this.configService.get('dataDir') ?? configuration_1.DEFAULT_DATA_DIR;
        this.registryPath = path.join(this.dataDir, 'plugins', 'registry.json');
        this.maxPluginStorageBytes =
            this.configService.get('plugins.storageMaxBytes') ?? DEFAULT_MAX_PLUGIN_STORAGE_BYTES;
        this.loadRegistry();
    }
    loadRegistry() {
        try {
            if (fs.existsSync(this.registryPath)) {
                const content = fs.readFileSync(this.registryPath, 'utf-8');
                const entries = JSON.parse(content);
                if (!Array.isArray(entries))
                    throw new Error('registry is not a JSON array');
                this.registry = new Map(entries.map(e => [e.id, e]));
                this.logger.debug(`Loaded ${this.registry.size} plugins from registry`, {
                    action: 'registry_loaded',
                });
            }
        }
        catch (error) {
            // The next save (every boot registers plugins) would replace the unreadable file with an empty
            // registry, losing every plugin's config, secrets and enable decision for good. Move it aside
            // first so the operator can repair and restore it.
            const movedTo = `${this.registryPath}.corrupt-${Date.now()}`;
            try {
                fs.renameSync(this.registryPath, movedTo);
                this.logger.error(`Failed to load plugin registry; moved it to ${movedTo}`, String(error), {
                    action: 'registry_load_failed',
                    movedTo,
                });
            }
            catch {
                this.logger.error('Failed to load plugin registry', String(error), {
                    action: 'registry_load_failed',
                });
            }
        }
    }
    /** Best-effort write, for the load path and runtime status, where a disk fault must not fail the caller. */
    saveRegistry() {
        try {
            this.writeRegistry();
        }
        catch {
            /* logged by writeRegistry */
        }
    }
    writeRegistry() {
        try {
            const dir = path.dirname(this.registryPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }
            const entries = Array.from(this.registry.values());
            // Owner-only: plugin config can hold secrets (e.g. an API key). writeFileSync's mode only
            // applies on CREATE, so chmod an already-existing, looser file too (best-effort).
            atomicWriteFileSync(this.registryPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
            try {
                fs.chmodSync(this.registryPath, 0o600);
            }
            catch {
                /* best-effort hardening */
            }
        }
        catch (error) {
            this.logger.error('Failed to save plugin registry', String(error), {
                action: 'registry_save_failed',
            });
            throw error;
        }
    }
    /**
     * Apply a change to an entry and write it. With `mustPersist` a registry that cannot be written puts the entry
     * back and throws PluginRegistryWriteError; without it the change stays and the write is best-effort.
     */
    commitEntryChange(entry, change, { mustPersist = false } = {}) {
        if (!mustPersist) {
            Object.assign(entry, change, { updatedAt: new Date() });
            this.saveRegistry();
            return;
        }
        const keys = [...Object.keys(change), 'updatedAt'];
        const previous = Object.fromEntries(keys.map(key => [key, entry[key]]));
        Object.assign(entry, change, { updatedAt: new Date() });
        try {
            this.writeRegistry();
        }
        catch (error) {
            Object.assign(entry, previous);
            throw new PluginRegistryWriteError(error);
        }
    }
    // ============================================================================
    // Registry Methods
    // ============================================================================
    getPluginEntry(pluginId) {
        return this.registry.get(pluginId);
    }
    setPluginEntry(entry) {
        entry.updatedAt = new Date();
        this.registry.set(entry.id, entry);
        this.saveRegistry();
    }
    /** Throws PluginRegistryWriteError, keeping the entry, when the registry cannot be written. */
    deletePluginEntry(pluginId) {
        const entry = this.registry.get(pluginId);
        if (!entry)
            return;
        this.registry.delete(pluginId);
        try {
            this.writeRegistry();
        }
        catch (error) {
            this.registry.set(pluginId, entry);
            throw new PluginRegistryWriteError(error);
        }
    }
    getAllEntries() {
        return Array.from(this.registry.values());
    }
    // ============================================================================
    // Status Management
    // ============================================================================
    getPluginStatus(pluginId) {
        const entry = this.registry.get(pluginId);
        return entry?.status ?? null;
    }
    setPluginStatus(pluginId, status) {
        const entry = this.registry.get(pluginId);
        if (entry) {
            entry.status = status;
            entry.updatedAt = new Date();
            this.saveRegistry();
        }
    }
    /**
     * Record the operator's standing enable decision, which outlives the process (#856). Deliberately
     * separate from setPluginStatus: `status` tracks where the runtime is right now and is reset on every
     * load, so writing intent through it would lose it on the next boot. Call this only from the
     * operator-facing enable/disable — never from the shutdown teardown, which disables every running
     * plugin and would otherwise erase the decision on the way out. Throws PluginRegistryWriteError when the
     * decision cannot be stored.
     */
    setPluginEnabledByOperator(pluginId, enabled) {
        const entry = this.registry.get(pluginId);
        if (entry)
            this.commitEntryChange(entry, { enabledByOperator: enabled }, { mustPersist: true });
    }
    /**
     * Empty an entry of what the operator set (config, session activation and per-session config, the enable
     * decision), keeping the entry. The decision is stored as false: left absent, a lingering ENABLED status would be
     * adopted as one at the next load. With `mustPersist`, throws PluginRegistryWriteError when it cannot be stored.
     */
    clearOperatorSettings(pluginId, opts) {
        const entry = this.registry.get(pluginId);
        if (entry) {
            this.commitEntryChange(entry, { config: {}, activeSessions: undefined, sessionConfig: undefined, enabledByOperator: false }, opts);
        }
    }
    // ============================================================================
    // Config Management
    // ============================================================================
    getPluginConfig(pluginId) {
        const entry = this.registry.get(pluginId);
        return entry?.config ?? null;
    }
    /** With `mustPersist`, throws PluginRegistryWriteError when the config cannot be stored. */
    setPluginConfig(pluginId, config, opts) {
        const entry = this.registry.get(pluginId);
        if (entry)
            this.commitEntryChange(entry, { config }, opts);
    }
    getPluginSessions(pluginId) {
        const entry = this.registry.get(pluginId);
        return entry?.activeSessions ?? null;
    }
    /** With `mustPersist`, throws PluginRegistryWriteError when the activation cannot be stored. */
    setPluginSessions(pluginId, sessions, opts) {
        const entry = this.registry.get(pluginId);
        if (entry)
            this.commitEntryChange(entry, { activeSessions: sessions }, opts);
    }
    getPluginSessionConfig(pluginId) {
        const entry = this.registry.get(pluginId);
        return entry?.sessionConfig ?? null;
    }
    /** With `mustPersist`, throws PluginRegistryWriteError when the per-session config cannot be stored. */
    setPluginSessionConfig(pluginId, sessionConfig, opts) {
        const entry = this.registry.get(pluginId);
        if (entry)
            this.commitEntryChange(entry, { sessionConfig }, opts);
    }
    // ============================================================================
    // Plugin Data Storage (sandboxed per-plugin storage)
    // ============================================================================
    /**
     * Remove a plugin's entire data-storage directory (<dataDir>/plugins/<id>). Called on uninstall.
     * Containment-guarded exactly like the package-dir delete in the loader: an id that resolves
     * outside the storage root is refused, so only the named plugin's directory can ever be touched.
     * A removal failure is logged and thrown, so the uninstall fails with its registry entry still present,
     * already emptied of its operator settings.
     */
    deletePluginData(pluginId) {
        const root = path.resolve(this.dataDir, 'plugins');
        const dir = path.resolve(root, pluginId);
        if (dir === root || !dir.startsWith(root + path.sep)) {
            this.logger.warn(`Refusing to delete plugin storage outside the storage root: ${pluginId}`, {
                pluginId,
                action: 'plugin_storage_delete_refused',
            });
            return;
        }
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            this.storageUsage.delete(pluginId);
            this.logger.debug(`Deleted plugin storage: ${pluginId}`, { pluginId, action: 'plugin_storage_deleted' });
        }
        catch (error) {
            this.logger.warn(`Failed to delete plugin storage for ${pluginId}`, {
                pluginId,
                action: 'plugin_storage_delete_failed',
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    /**
     * Reject a write that would push the plugin's storage past maxPluginStorageBytes. Only the encoded
     * `key-*.json` files count — they are the only files a plugin can create through this service (new
     * writes always use the encoded name), and when code and state share a directory the plugin's own
     * package files must not eat its quota. The file being overwritten is excluded from the current
     * usage so replacing a large key does not count its bytes twice.
     */
    assertStorageQuota(pluginDataDir, targetPath, incomingBytes, pluginId) {
        let replaced = 0;
        try {
            replaced = fs.statSync(targetPath).size;
        }
        catch {
            /* a new key */
        }
        // The running total is seeded by one scan and kept in step by set/delete, so a write costs one stat
        // instead of a read of the whole directory: that read ran synchronously on the host's main thread for
        // every write and grew with the number of keys the plugin had stored (about 50 ms per write at 20,000).
        let total = this.storageUsage.get(pluginId) ?? this.scanStorageBytes(pluginDataDir);
        let used = Math.max(0, total - replaced);
        if (used + incomingBytes > this.maxPluginStorageBytes) {
            // Files removed behind the service's back leave the total too high; confirm against the directory
            // before refusing the write.
            total = this.scanStorageBytes(pluginDataDir);
            used = Math.max(0, total - replaced);
            this.storageUsage.set(pluginId, total);
        }
        if (used + incomingBytes > this.maxPluginStorageBytes) {
            throw new Error(`Plugin ${pluginId} storage quota exceeded: this write would bring the plugin to ${used + incomingBytes} bytes (max ${this.maxPluginStorageBytes}). Delete unused keys or raise PLUGIN_STORAGE_MAX_BYTES.`);
        }
        return used;
    }
    /** Bytes held by the plugin's encoded key files, read from the directory. */
    scanStorageBytes(pluginDataDir) {
        let total = 0;
        for (const entry of fs.readdirSync(pluginDataDir)) {
            if (!entry.startsWith(ENCODED_KEY_PREFIX) || !entry.endsWith('.json'))
                continue;
            try {
                total += fs.statSync(path.join(pluginDataDir, entry)).size;
            }
            catch {
                /* vanished between readdir and stat; ignore */
            }
        }
        return total;
    }
    /** Take a removed key's bytes out of the running total, if one has been seeded. */
    releaseStorageBytes(pluginId, bytes) {
        const total = this.storageUsage.get(pluginId);
        if (total !== undefined)
            this.storageUsage.set(pluginId, Math.max(0, total - bytes));
    }
    createPluginStorage(pluginId) {
        const pluginDataDir = path.join(this.dataDir, 'plugins', pluginId);
        // Ensure directory exists. 0o700 (owner-only) because plugin storage holds the same class of
        // secret as the registry (OAuth/refresh tokens, webhook secrets a plugin persists) — mirror the
        // hardening saveRegistry already applies rather than inherit a group/other-readable umask default.
        if (!fs.existsSync(pluginDataDir)) {
            fs.mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
        }
        const logger = this.logger;
        // Containment: validate the logical key, then encode it to a filesystem-safe filename. This keeps
        // JID-style keys (`group:sess-1:12345@g.us`) portable on Windows while still rejecting traversal.
        const resolveKeyPath = (key) => {
            if (!(0, path_safety_1.isSafeStorageKey)(key))
                return null;
            const fileName = `${encodeStorageKey(key)}.json`;
            return (0, path_safety_1.isPathWithin)(pluginDataDir, fileName) ? path.join(pluginDataDir, fileName) : null;
        };
        // Backward compatibility for pre-encoded storage files (`state.json`). Reads/deletes consult it,
        // but new writes always use the encoded filename above.
        const resolveLegacyKeyPath = (key) => {
            if (!(0, path_safety_1.isSafeStorageKey)(key))
                return null;
            // These are package-owned files when package code and state share a directory. They must never
            // be treated as legacy plugin storage (or get/delete/set migration can read or remove code).
            if (key === 'manifest' || key === 'package')
                return null;
            // A canonical encoded filename belongs to the key it decodes to, not to a legacy key spelled like it.
            if (decodeStorageFileName(key) !== null)
                return null;
            const fileName = `${key}.json`;
            return (0, path_safety_1.isPathWithin)(pluginDataDir, fileName) ? path.join(pluginDataDir, fileName) : null;
        };
        return {
            get: (key) => {
                const filePath = resolveKeyPath(key);
                if (!filePath) {
                    logger.warn(`Refusing to read plugin data with an unsafe key: ${pluginId}/${key}`);
                    return Promise.resolve(null);
                }
                try {
                    const legacyPath = resolveLegacyKeyPath(key);
                    const candidates = legacyPath && legacyPath !== filePath ? [filePath, legacyPath] : [filePath];
                    for (const candidate of candidates) {
                        if (fs.existsSync(candidate)) {
                            const content = fs.readFileSync(candidate, 'utf-8');
                            return Promise.resolve(JSON.parse(content));
                        }
                    }
                }
                catch (error) {
                    logger.error(`Failed to read plugin data: ${pluginId}/${key}`, String(error));
                }
                return Promise.resolve(null);
            },
            set: (key, value) => {
                const filePath = resolveKeyPath(key);
                if (!filePath) {
                    return Promise.reject(new Error(`Unsafe plugin storage key: ${key}`));
                }
                try {
                    const payload = JSON.stringify(value, null, 2);
                    const bytes = Buffer.byteLength(payload, 'utf8');
                    const usedByOtherKeys = this.assertStorageQuota(pluginDataDir, filePath, bytes, pluginId);
                    // 0o600 (owner-only): a plugin-persisted secret must not land in a group/other-readable file.
                    // The mode on the temp write carries through the rename; chmod is a backstop if the target
                    // pre-existed (writeFileSync mode only applies on create). Mirrors saveRegistry's hardening.
                    atomicWriteFileSync(filePath, payload, { mode: 0o600 });
                    fs.chmodSync(filePath, 0o600);
                    this.storageUsage.set(pluginId, usedByOtherKeys + bytes);
                    // Keep any legacy file in place. Encoded-first reads and de-duplicated lists ensure it cannot
                    // shadow this write, while avoiding an unlink outside the service-owned key-* namespace.
                    return Promise.resolve();
                }
                catch (error) {
                    logger.error(`Failed to write plugin data: ${pluginId}/${key}`, String(error));
                    return Promise.reject(new Error(error instanceof Error ? error.message : String(error)));
                }
            },
            delete: (key) => {
                const filePath = resolveKeyPath(key);
                if (!filePath) {
                    return Promise.reject(new Error(`Unsafe plugin storage key: ${key}`));
                }
                try {
                    const legacyPath = resolveLegacyKeyPath(key);
                    const candidates = legacyPath && legacyPath !== filePath ? [filePath, legacyPath] : [filePath];
                    for (const candidate of candidates) {
                        if (fs.existsSync(candidate)) {
                            // Only the encoded file counts toward the quota; a legacy file is never in the total.
                            const bytes = candidate === filePath ? fs.statSync(candidate).size : 0;
                            fs.unlinkSync(candidate);
                            this.releaseStorageBytes(pluginId, bytes);
                        }
                    }
                    return Promise.resolve();
                }
                catch (error) {
                    logger.error(`Failed to delete plugin data: ${pluginId}/${key}`, String(error));
                    return Promise.reject(new Error(error instanceof Error ? error.message : String(error)));
                }
            },
            list: (prefix) => {
                try {
                    const files = fs.readdirSync(pluginDataDir);
                    // A legacy stem is listed only when get()/delete() would consult it, so the package's own
                    // manifest.json/package.json never surface as keys that read back null. In a package directory
                    // (storage and the installed package share it by default) every other root JSON file is package
                    // content too, so only encoded keys are listed there; get()/delete() still honor a legacy key
                    // the plugin names explicitly.
                    const isPackageDir = files.includes('manifest.json');
                    let keys = Array.from(new Set(files
                        .filter(f => f.endsWith('.json'))
                        .map(f => f.slice(0, -'.json'.length))
                        .map(stem => {
                        // A listed key must be one get/set/delete accept, so a canonical name that decodes to an
                        // unsafe or empty key is not listed (and is not a legacy key either, see resolveLegacyKeyPath).
                        const decoded = decodeStorageFileName(stem);
                        if (decoded !== null)
                            return (0, path_safety_1.isSafeStorageKey)(decoded) ? decoded : null;
                        return !isPackageDir && resolveLegacyKeyPath(stem) ? stem : null;
                    })
                        .filter((k) => k !== null)));
                    if (prefix) {
                        keys = keys.filter(k => k.startsWith(prefix));
                    }
                    return Promise.resolve(keys);
                }
                catch (error) {
                    logger.error(`Failed to list plugin data: ${pluginId}`, String(error));
                    return Promise.resolve([]);
                }
            },
        };
    }
};
exports.PluginStorageService = PluginStorageService;
exports.PluginStorageService = PluginStorageService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], PluginStorageService);
