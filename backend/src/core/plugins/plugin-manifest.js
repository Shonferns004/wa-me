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
exports.INSTALLABLE_TYPES = exports.RESERVED_PLUGIN_IDS = void 0;
exports.validatePluginManifest = validatePluginManifest;
const path = __importStar(require("path"));
const plugin_interfaces_1 = require("./plugin.interfaces");
const catalog_1 = require("../../modules/plugins/catalog");
// The version of the running code (same source as /api/health), the default floor check target.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: HOST_VERSION } = require('../../../package.json');
/**
 * Plugin ids a plugin package / directory must never use. `whatsapp-web.js` / `baileys` are built-in
 * engines; `auto-reply` / `translation` are the legacy bundled-extension ids (removed in v0.7 —
 * superseded by the marketplace `chat-flow` / `group-translate`) kept reserved so a re-upload or a
 * hand-placed directory can't shadow them.
 */
exports.RESERVED_PLUGIN_IDS = new Set(['whatsapp-web.js', 'baileys', 'auto-reply', 'translation']);
/** Only extensions are user-installable / directory-loadable; engines (and other tiers) are built-in by design. */
exports.INSTALLABLE_TYPES = new Set([plugin_interfaces_1.PluginType.EXTENSION]);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const REQUIRED_FIELDS = ['id', 'name', 'version', 'type', 'main'];
// compareSemver reads garbage as 0.0.0, so a floor must be well-formed before it is compared.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/**
 * The manifest validation BOTH install-time (parsePluginPackage) and boot-time
 * (PluginLoaderService.loadPlugin) enforce, so a plugin that could never be installed can never be
 * boot-loaded from a hand-placed or crash-leftover directory either. Throws a plain Error with the
 * shared message; each caller maps it to its own surface (install → HTTP 400, boot → load failure
 * logged + the directory skipped).
 *
 * Checks: plain-object shape; required fields present as non-empty strings; id format + reserved
 * ids; installable (extension) type; that `permissions`, `sessions`, `hooks` and `net.allow` /
 * `net.allowConfigHosts` are string arrays when present; that `main` is a relative path that
 * cannot escape the plugin directory; and that an optional `minOpenWAVersion` is a MAJOR.MINOR.PATCH version no newer
 * than `hostVersion` (pre-release suffixes are ignored, so 0.24.0-rc.1 satisfies 0.24.0). The
 * `main` check here is lexical (forward-slash semantics); the loader additionally anchors it
 * against the real on-disk directory, which also catches platform-separator tricks, and requires
 * the entry file to exist (parity with install's in-archive check).
 */
function validatePluginManifest(manifest, hostVersion = HOST_VERSION) {
    // JSON.parse("null") / "[]" / "5" don't throw — but indexing a field on a non-object then throws a
    // TypeError downstream. Require a plain object up front.
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        throw new Error('manifest.json must be a JSON object');
    }
    const m = manifest;
    for (const field of REQUIRED_FIELDS) {
        // Require a non-empty STRING: a non-string value (e.g. `main: 123`) is truthy and would pass a
        // bare falsy check, then crash a string-only API like path.posix.normalize with a TypeError.
        if (typeof m[field] !== 'string' || m[field].length === 0) {
            throw new Error(`manifest.json is missing or has an invalid required field: ${field}`);
        }
    }
    if (!SAFE_ID.test(m.id) || m.id.includes('..')) {
        throw new Error(`Invalid plugin id: "${m.id}"`);
    }
    // SAFE_ID accepts mixed case, so the reservation check is case-insensitive — else `Auto-Reply`
    // loads as a distinct plugin that shadows the reserved `auto-reply`.
    if (exports.RESERVED_PLUGIN_IDS.has(m.id.toLowerCase())) {
        throw new Error(`Plugin id "${m.id}" is reserved by a built-in plugin`);
    }
    if (!exports.INSTALLABLE_TYPES.has(m.type)) {
        throw new Error(`Plugin type "${m.type}" is not installable — only extension plugins can be installed (engines and other tiers are built-in).`);
    }
    assertMainContained(m.main);
    // The consumers match these with `.includes`, which also works on a string: `sessions: 'sales-team'`
    // would admit session 'sales'. Require real string arrays (null reads as absent, like the consumers).
    assertStringArray(m.permissions, 'permissions');
    assertStringArray(m.sessions, 'sessions');
    assertStringArray(m.hooks, 'hooks');
    const net = m.net;
    if (net !== undefined && net !== null) {
        if (typeof net !== 'object' || Array.isArray(net)) {
            throw new Error('manifest.json net must be an object');
        }
        assertStringArray(m.net?.allow, 'net.allow');
        assertStringArray(m.net?.allowConfigHosts, 'net.allowConfigHosts');
    }
    const min = m.minOpenWAVersion;
    if (min !== undefined && min !== null) {
        if (typeof min !== 'string' || !SEMVER.test(min)) {
            throw new Error('manifest.json minOpenWAVersion must be a MAJOR.MINOR.PATCH version');
        }
        if ((0, catalog_1.compareSemver)(hostVersion, min) < 0) {
            throw new Error(`Plugin ${m.id} requires OpenWA >= ${min} (running ${hostVersion})`);
        }
    }
}
function assertStringArray(value, field) {
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.every(v => typeof v === 'string'))) {
        throw new Error(`manifest.json ${field} must be an array of strings`);
    }
}
/**
 * Lexical containment for a manifest `main`: a relative, forward-slash path that stays inside the
 * plugin directory. Rejects absolute paths, `..` escapes, and backslashes (the install pipeline
 * rejects backslash archive paths outright, so a loadable main never contains one — a Windows-style
 * `..\x` would otherwise sail through the forward-slash checks and escape on a Windows host).
 */
function assertMainContained(main) {
    const normalized = path.posix.normalize(main);
    if (path.posix.isAbsolute(main) || normalized === '..' || normalized.startsWith('../') || main.includes('\\')) {
        throw new Error(`manifest.json main escapes the plugin directory: "${main}"`);
    }
}
