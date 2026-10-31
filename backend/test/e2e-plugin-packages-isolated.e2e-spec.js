"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * setup-e2e.ts gives every suite its own state roots so a run never reads or writes the developer's
 * ./data tree. The plugin PACKAGE directory belongs to that set: the loader scans it (and, while
 * PLUGINS_DIR is unset, the legacy ./plugins too) at every AppModule boot, reconciles leftovers in it,
 * and installs into it. It must therefore resolve inside the suite's temp root, like the registry.
 */
const path_1 = require("path");
const os_1 = require("os");
const configuration_1 = __importDefault(require("../src/config/configuration"));
describe('e2e plugin package directory', () => {
    it('resolves inside the temp state root and scans no legacy tree', () => {
        const { plugins } = (0, configuration_1.default)();
        expect((0, path_1.resolve)(plugins.dir).startsWith((0, path_1.resolve)((0, os_1.tmpdir)()) + path_1.sep)).toBe(true);
        expect(plugins.legacyDir).toBeNull();
    });
});
