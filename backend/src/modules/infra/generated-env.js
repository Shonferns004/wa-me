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
exports.generatedEnvPath = void 0;
exports.readGeneratedEnv = readGeneratedEnv;
exports.encodeGeneratedEnvValue = encodeGeneratedEnvValue;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
/**
 * `data/.env.generated` — the dashboard-written env overlay, one KEY=value per line, merged into
 * `process.env` on the next boot (after `process.env` and `.env`, all `override: false`).
 *
 * Resolved per call rather than captured at import: the location is relative to `process.cwd()`, and
 * the controller has always re-derived it on each use.
 *
 * NOT shared with `database/load-cli-env.ts`, which resolves the same filename against an injected
 * `cwd` so it stays testable without chdir. Folding that into this helper would remove its seam.
 */
const generatedEnvPath = () => path.resolve(process.cwd(), 'data', '.env.generated');
exports.generatedEnvPath = generatedEnvPath;
/**
 * Parsed contents, or `{}` when the file has never been written.
 *
 * Three reads share this — the built-in-flag fallback behind the Docker probe
 * (InfraStatusController.readSavedBuiltinFlags), the config form's hydrate
 * (InfraConfigController.getConfig), and the merge base the save path writes back over
 * (InfraConfigController.saveConfig). Re-deriving the location at each of them made the file an
 * undeclared dependency shared between reading infrastructure status, rendering the form, and
 * persisting credentials: three concerns that otherwise touch none of the same state.
 */
function readGeneratedEnv() {
    const envPath = (0, exports.generatedEnvPath)();
    return fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
}
/**
 * `value` in the form dotenv reads back unchanged, or `undefined` when no form does. dotenv takes an
 * unquoted `#` as a comment and strips outer quotes and whitespace, so such a value is quoted; any
 * other value stays bare, which keeps existing files and scripts/lib-env.sh (plain lines only) as-is.
 * A leading quote is never left bare: it reads back on its own line, but in the whole file it opens a
 * quoted value that a later line holding the same quote character closes.
 */
function encodeGeneratedEnvValue(key, value) {
    const quoted = [`'${value}'`, `"${value}"`, `\`${value}\``];
    return (/^['"`]/.test(value) ? quoted : [value, ...quoted]).find(form => dotenv.parse(`${key}=${form}`)[key] === value);
}
