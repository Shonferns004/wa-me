"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        writeFileSync: jest.fn(),
        // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
        // so the secret-hygiene path never touches the real filesystem.
        chmodSync: jest.fn(),
        existsSync: jest.fn().mockReturnValue(false),
        readFileSync: jest.fn().mockReturnValue(''),
        createReadStream: jest.fn(() => jest.requireActual('stream').Readable.from([])),
    };
});
const core_1 = require("@nestjs/core");
const infra_status_controller_1 = require("./infra-status.controller");
const infra_config_controller_1 = require("./infra-config.controller");
const infra_data_controller_1 = require("./infra-data.controller");
const infra_storage_controller_1 = require("./infra-storage.controller");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
describe('Infra controllers access control', () => {
    const reflector = new core_1.Reflector();
    // Every mutating, data-exfiltration, and operational-read endpoint must require
    // the ADMIN role so that a low-privilege (VIEWER/OPERATOR) API key cannot wipe
    // data, read secrets, change config, restart, trigger storage import, or read
    // infrastructure status / engine / storage details (#221 tightened the reads).
    const adminOnly = [
        [infra_config_controller_1.InfraConfigController, 'getConfig'], // GET  /infra/config (returns saved config; secrets omitted but still ADMIN-only)
        [infra_config_controller_1.InfraConfigController, 'saveConfig'], // PUT  /infra/config
        [infra_config_controller_1.InfraConfigController, 'requestRestart'], // POST /infra/restart
        [infra_data_controller_1.InfraDataController, 'exportData'], // GET  /infra/export-data  (dumps every data-DB table)
        [infra_data_controller_1.InfraDataController, 'importData'], // POST /infra/import-data  (DELETEs all rows)
        [infra_storage_controller_1.InfraStorageController, 'exportStorage'], // GET  /infra/storage/export
        [infra_storage_controller_1.InfraStorageController, 'importStorage'], // POST /infra/storage/import
        [infra_status_controller_1.InfraStatusController, 'getStatus'], // GET  /infra/status
        [infra_status_controller_1.InfraStatusController, 'getEngines'], // GET  /infra/engines
        [infra_status_controller_1.InfraStatusController, 'getCurrentEngine'], // GET  /infra/engines/current
        [infra_status_controller_1.InfraStatusController, 'getUpdateCheck'], // GET  /infra/update-check (outbound request to GitHub)
        [infra_storage_controller_1.InfraStorageController, 'getStorageFileCount'], // GET  /infra/storage/files/count
    ];
    it.each(adminOnly.map(([ControllerClass, method]) => ({
        label: `${ControllerClass.name}.${method}`,
        ControllerClass,
        method,
    })))('$label requires the ADMIN role', ({ ControllerClass, method }) => {
        // The handler is only ever a lookup key for reflector metadata — it is never invoked, so there is
        // no `this` to lose. unbound-method (tightened in typescript-eslint 8.65) cannot tell the two
        // apart, and the cast below does not satisfy it either.
        const handler = ControllerClass.prototype[method];
        const role = reflector.get(auth_decorators_1.REQUIRED_ROLE_KEY, handler);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.ADMIN);
    });
});
