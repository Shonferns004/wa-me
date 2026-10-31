"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin_manifest_1 = require("./plugin-manifest");
/**
 * The shared manifest contract enforced identically at install time (parsePluginPackage) and at
 * boot time (PluginLoaderService.loadPlugin): a plugin that could never be installed must never be
 * boot-loaded from a hand-placed directory either.
 */
describe('validatePluginManifest', () => {
    const valid = { id: 'my-plg', name: 'My Plugin', version: '1.0.0', type: 'extension', main: 'index.js' };
    it('accepts a valid manifest', () => {
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid })).not.toThrow();
    });
    it('rejects a non-object manifest (null / array / scalar)', () => {
        for (const body of [null, [], 'x', 5, true]) {
            expect(() => (0, plugin_manifest_1.validatePluginManifest)(body)).toThrow(/must be a JSON object/i);
        }
    });
    it('rejects a missing required field', () => {
        const bad = { ...valid, main: undefined };
        expect(() => (0, plugin_manifest_1.validatePluginManifest)(bad)).toThrow(/required field: main/i);
    });
    it('rejects a list field that is not an array of strings', () => {
        // `.includes` also works on a string, so `sessions: 'sales-team'` would match session 'sales'.
        for (const field of ['permissions', 'sessions', 'hooks']) {
            for (const value of ['sales-team', [1], {}]) {
                expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, [field]: value })).toThrow(`manifest.json ${field} must be an array of strings`);
            }
        }
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, net: { allow: 'api.example.com' } })).toThrow('manifest.json net.allow must be an array of strings');
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, net: { allowConfigHosts: 'baseUrl' } })).toThrow('manifest.json net.allowConfigHosts must be an array of strings');
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, net: ['api.example.com'] })).toThrow('manifest.json net must be an object');
    });
    it('accepts absent, null or string-array list fields', () => {
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({
            ...valid,
            permissions: ['net:fetch'],
            sessions: null,
            hooks: [],
            net: { allow: ['api.example.com'], allowConfigHosts: null },
        })).not.toThrow();
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, net: null })).not.toThrow();
    });
    it('rejects a non-string required field (numeric main)', () => {
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, main: 123 })).toThrow(/invalid required field/i);
    });
    it('rejects an unsafe plugin id', () => {
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, id: '../evil' })).toThrow(/invalid plugin id/i);
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, id: 'has space' })).toThrow(/invalid plugin id/i);
    });
    it('rejects a reserved id, case-insensitively', () => {
        for (const id of plugin_manifest_1.RESERVED_PLUGIN_IDS) {
            expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, id })).toThrow(/reserved/i);
        }
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, id: 'Auto-Reply' })).toThrow(/reserved/i);
    });
    it('rejects a non-installable type (engines and unknown tiers alike)', () => {
        for (const type of ['engine', 'storage', 'wormhole']) {
            expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, id: `plg-${type}`, type })).toThrow(/not installable/i);
        }
        expect(plugin_manifest_1.INSTALLABLE_TYPES.has('extension')).toBe(true);
    });
    it('rejects a main that escapes the plugin directory', () => {
        for (const main of ['../evil.js', '../../etc/passwd', '..', '/etc/passwd', 'a/../../b.js', '..\\evil.js']) {
            expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, main })).toThrow(/escapes the plugin directory/i);
        }
    });
    it('accepts nested and dot-relative mains inside the plugin directory', () => {
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, main: 'dist/main.js' })).not.toThrow();
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, main: './index.js' })).not.toThrow();
        expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, main: 'dist/../index.js' })).not.toThrow();
    });
    describe('minOpenWAVersion', () => {
        const host = '0.23.7';
        it('accepts an absent or null floor', () => {
            expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid }, host)).not.toThrow();
            expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, minOpenWAVersion: null }, host)).not.toThrow();
        });
        it('accepts a floor at or below the running host', () => {
            for (const min of ['0.23.7', '0.8.16', '0.0.1']) {
                expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, minOpenWAVersion: min }, host)).not.toThrow();
            }
        });
        it('rejects a floor above the running host, naming both versions', () => {
            expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, minOpenWAVersion: '0.24.0' }, host)).toThrow(/my-plg requires OpenWA >= 0\.24\.0 \(running 0\.23\.7\)/);
        });
        it('rejects a malformed floor instead of reading it as 0.0.0', () => {
            for (const min of ['v1.0.0', '1.2', 'garbage', 5, '']) {
                expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, minOpenWAVersion: min }, host)).toThrow(/minOpenWAVersion/);
            }
        });
        it('lets a prerelease host satisfy its own release floor', () => {
            expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, minOpenWAVersion: '0.24.0' }, '0.24.0-rc.1')).not.toThrow();
        });
        it('checks against the running package version by default', () => {
            expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, minOpenWAVersion: '0.0.1' })).not.toThrow();
            expect(() => (0, plugin_manifest_1.validatePluginManifest)({ ...valid, minOpenWAVersion: '999.0.0' })).toThrow(/requires OpenWA/);
        });
    });
});
