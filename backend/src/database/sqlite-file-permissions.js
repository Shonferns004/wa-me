"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqlitePermissionsBoot = void 0;
exports.tightenSqliteFilePermissions = tightenSqliteFilePermissions;
const fs_1 = require("fs");
const common_1 = require("@nestjs/common");
const logger_service_1 = require("../common/services/logger.service");
const config_1 = require("@nestjs/config");
// better-sqlite3 creates its database files with 0666 & umask (0644 under the usual 022), so the
// SQLite files end up group/world-readable while every sibling secret in data/ was tightened to
// 0600/0700. That matters because these files ARE secret stores: openwa.sqlite holds the webhook
// and plugin-instance HMAC secrets and session proxy URLs in plaintext. The container deployment is
// insulated (named volume, non-root user), but bare-metal and bind-mount hosts get world-readable
// secrets. Tighten on every boot, the same re-tighten-on-start posture the credential dirs use, so
// a file recreated by a restore or a copy also converges back.
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];
/**
 * chmod each database file (plus its WAL/rollback sidecars) to owner-only, best-effort: a failure is
 * logged and skipped, never allowed to fail the boot. Returns the paths actually tightened.
 */
function tightenSqliteFilePermissions(paths, warn) {
    const tightened = [];
    for (const path of paths) {
        for (const candidate of [path, ...SIDECAR_SUFFIXES.map(suffix => `${path}${suffix}`)]) {
            if (!(0, fs_1.existsSync)(candidate))
                continue;
            try {
                (0, fs_1.chmodSync)(candidate, 0o600);
                tightened.push(candidate);
            }
            catch (error) {
                warn(`Could not tighten ${candidate} to owner-only permissions: ` +
                    `${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    return tightened;
}
/**
 * Applies the tightening to the two bundled SQLite databases once every DataSource has initialized.
 * The DataSources initialize eagerly inside their provider factories (before any lifecycle hook
 * runs), and Nest runs every onModuleInit before any onApplicationBootstrap, so both files exist by
 * the time this hook fires. The main connection is always SQLite; the data connection mirrors the
 * app.module factory's own branch (everything except postgres is the sqlite path; env.validation
 * confines DATABASE_TYPE to those two).
 */
let SqlitePermissionsBoot = class SqlitePermissionsBoot {
    config;
    logger = (0, logger_service_1.createLogger)('SqlitePermissions');
    constructor(config) {
        this.config = config;
    }
    onApplicationBootstrap() {
        const paths = [this.config.get('database.database', './data/main.sqlite')];
        if (this.config.get('dataDatabase.type', 'sqlite') !== 'postgres') {
            paths.push(this.config.get('dataDatabase.database', './data/openwa.sqlite'));
        }
        tightenSqliteFilePermissions(paths, message => this.logger.warn(message));
    }
};
exports.SqlitePermissionsBoot = SqlitePermissionsBoot;
exports.SqlitePermissionsBoot = SqlitePermissionsBoot = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], SqlitePermissionsBoot);
