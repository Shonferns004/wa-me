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
exports.loadCliEnv = loadCliEnv;
const dotenv_1 = require("dotenv");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const env_precedence_1 = require("../config/env-precedence");
/**
 * Load environment for the standalone TypeORM CLI data-sources with the SAME precedence as
 * src/main.ts: `process.env` > `.env` > `data/.env.generated` (all dotenv `override: false`), with
 * blank compose-forwarded keys cleared first. Without this, the migration CLI ignored the
 * dashboard-written `data/.env.generated` and ran against the default SQLite DB even when the
 * deployment was configured (via the dashboard) for PostgreSQL — i.e. `migration:run:prod` targeted
 * the wrong database. `cwd` is injectable for testing.
 */
function loadCliEnv(cwd = process.cwd()) {
    (0, env_precedence_1.clearBlankEnv)(process.env, env_precedence_1.BLANK_SHADOWED_ENV_KEYS);
    const userEnvPath = path.resolve(cwd, '.env');
    const generatedEnvPath = path.resolve(cwd, 'data', '.env.generated');
    if (fs.existsSync(userEnvPath))
        (0, dotenv_1.config)({ path: userEnvPath, override: false, quiet: true });
    if (fs.existsSync(generatedEnvPath))
        (0, dotenv_1.config)({ path: generatedEnvPath, override: false, quiet: true });
}
