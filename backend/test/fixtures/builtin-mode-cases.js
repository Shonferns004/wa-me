"use strict";
// The saved built-in mode GET /infra/config answers with, for every state of the saved file and of what the
// environment pins for the service's host key. One table for both halves of the Infrastructure page: the
// controller specs assert the answer, the dashboard page tests render the form from it.
//
// The rule, per service (database, redis, storage): the host the next boot dials decides whether the service is
// built-in, and a *_BUILTIN flag only whether the bundled container starts at boot.
//  1. A host pinned by the environment decides: pinned to the bundled host is built-in, anything else is not,
//     and the saved flag says nothing (builtInSet false).
//  2. Otherwise the file's host decides (none is the default host, which is not the bundled container). The flag
//     counts as a saved choice (builtInSet true) when the environment pins it or the file also selects the service.
//     The first boot writes every flag as false next to a service that is not selected, which is a default, not a
//     choice. A flag that is not true beside the bundled host name in the file is no choice of an external service
//     either: the next boot dials the container (builtIn true, builtInSet false).
//  3. Otherwise nothing is saved (builtInSet false) and the page follows what runs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOST_SPELLINGS = exports.FALLBACK_BUILT_IN = exports.EXPECTED_MODE_FLAG_PINNED = exports.EXPECTED_MODE = exports.SERVICES = exports.SERVICE_NAMES = exports.PIN_STATES = exports.FILE_STATES = void 0;
exports.fileHost = fileHost;
exports.fileLines = fileLines;
exports.pinnedHost = pinnedHost;
exports.FILE_STATES = [
    'absent',
    'template',
    'stored-false',
    'stored-true',
    'unselected-true',
    'bundled-host',
    'saved-bundled',
];
exports.PIN_STATES = ['none', 'bundled', 'external'];
exports.SERVICE_NAMES = ['database', 'redis', 'storage'];
exports.SERVICES = {
    database: {
        flag: 'POSTGRES_BUILTIN',
        host: 'DATABASE_HOST',
        bundledHost: 'postgres',
        externalHost: 'db.external.example',
        selection: 'DATABASE_TYPE',
        selected: 'postgres',
        unselected: 'sqlite',
    },
    redis: {
        flag: 'REDIS_BUILTIN',
        host: 'REDIS_HOST',
        bundledHost: 'redis',
        externalHost: 'cache.external.example',
        selection: 'REDIS_ENABLED',
        selected: 'true',
        unselected: 'false',
    },
    storage: {
        flag: 'MINIO_BUILTIN',
        host: 'S3_ENDPOINT',
        bundledHost: 'http://minio:9000',
        externalHost: 'https://s3.external.example',
        selection: 'STORAGE_TYPE',
        selected: 's3',
        unselected: 'local',
    },
};
const PINNED_BUNDLED = { builtIn: true, builtInSet: false };
const PINNED_EXTERNAL = { builtIn: false, builtInSet: false };
exports.EXPECTED_MODE = {
    // Nothing in the file about the service.
    absent: {
        none: { builtIn: false, builtInSet: false },
        bundled: PINNED_BUNDLED,
        external: PINNED_EXTERNAL,
    },
    // What the first boot writes: the flag false, the service not selected.
    template: {
        none: { builtIn: false, builtInSet: false },
        bundled: PINNED_BUNDLED,
        external: PINNED_EXTERNAL,
    },
    // Saved from the dashboard with the service selected.
    'stored-false': {
        none: { builtIn: false, builtInSet: true },
        bundled: PINNED_BUNDLED,
        external: PINNED_EXTERNAL,
    },
    // The flag true without the bundled host: the next boot dials the default host, so the choice is external.
    'stored-true': {
        none: { builtIn: false, builtInSet: true },
        bundled: PINNED_BUNDLED,
        external: PINNED_EXTERNAL,
    },
    // A flag left true beside a service the file does not select.
    'unselected-true': {
        none: { builtIn: false, builtInSet: false },
        bundled: PINNED_BUNDLED,
        external: PINNED_EXTERNAL,
    },
    // The service selected, the flag false and the bundled host name typed in the file (a compose name).
    'bundled-host': {
        none: { builtIn: true, builtInSet: false },
        bundled: PINNED_BUNDLED,
        external: PINNED_EXTERNAL,
    },
    // What the dashboard writes for a saved built-in choice: the service selected, the flag true, the bundled host.
    'saved-bundled': {
        none: { builtIn: true, builtInSet: true },
        bundled: PINNED_BUNDLED,
        external: PINNED_EXTERNAL,
    },
};
/**
 * The built-in mode GET /infra/config answers when the environment pins the service's flag and not its host: the
 * file's host still decides (rule 2), and the pinned flag counts as a saved choice. A pinned host decides as in
 * EXPECTED_MODE whatever the flag.
 */
exports.EXPECTED_MODE_FLAG_PINNED = {
    absent: { true: { builtIn: false, builtInSet: true }, false: { builtIn: false, builtInSet: true } },
    template: { true: { builtIn: false, builtInSet: true }, false: { builtIn: false, builtInSet: true } },
    'stored-false': { true: { builtIn: false, builtInSet: true }, false: { builtIn: false, builtInSet: true } },
    'stored-true': { true: { builtIn: false, builtInSet: true }, false: { builtIn: false, builtInSet: true } },
    'unselected-true': { true: { builtIn: false, builtInSet: true }, false: { builtIn: false, builtInSet: true } },
    'bundled-host': { true: { builtIn: true, builtInSet: true }, false: { builtIn: true, builtInSet: false } },
    'saved-bundled': { true: { builtIn: true, builtInSet: true }, false: { builtIn: true, builtInSet: false } },
};
/**
 * What GET /infra/status answers with Docker unreachable, where there is no container to see. A host name alone proves
 * nothing there (an external server may be called postgres), so the flag must be true, the environment's, else the
 * file's; and a flag beside a host that does not reach the bundled container proves nothing either, since the process
 * dials that host. The process runs on the pinned host, else the file's.
 */
exports.FALLBACK_BUILT_IN = {
    absent: { none: false, bundled: false, external: false },
    template: { none: false, bundled: false, external: false },
    'stored-false': { none: false, bundled: false, external: false },
    'stored-true': { none: false, bundled: true, external: false },
    'unselected-true': { none: false, bundled: true, external: false },
    'bundled-host': { none: false, bundled: false, external: false },
    'saved-bundled': { none: true, bundled: true, external: false },
};
/** The host the file names for a service in a given state, or undefined when it names none. */
function fileHost(service, state) {
    return state === 'bundled-host' || state === 'saved-bundled' ? exports.SERVICES[service].bundledHost : undefined;
}
/** The lines a saved file holds about one service in a given state. */
function fileLines(service, state) {
    const spec = exports.SERVICES[service];
    switch (state) {
        case 'absent':
            return [];
        case 'template':
            return [`${spec.selection}=${spec.unselected}`, `${spec.flag}=false`];
        case 'stored-false':
            return [`${spec.selection}=${spec.selected}`, `${spec.flag}=false`];
        case 'stored-true':
            return [`${spec.selection}=${spec.selected}`, `${spec.flag}=true`];
        case 'unselected-true':
            return [`${spec.selection}=${spec.unselected}`, `${spec.flag}=true`];
        case 'bundled-host':
            return [`${spec.selection}=${spec.selected}`, `${spec.flag}=false`, `${spec.host}=${spec.bundledHost}`];
        case 'saved-bundled':
            return [`${spec.selection}=${spec.selected}`, `${spec.flag}=true`, `${spec.host}=${spec.bundledHost}`];
    }
}
/** The host the environment pins for a service, or undefined when it pins none. */
function pinnedHost(service, pin) {
    const spec = exports.SERVICES[service];
    return pin === 'none' ? undefined : pin === 'bundled' ? spec.bundledHost : spec.externalHost;
}
/**
 * Host spellings for each service. `reach` names the bundled container all the same: Docker's DNS answers to its
 * network alias and its container name, in any letter case and as an absolute name with a trailing dot (for storage,
 * the host of the endpoint URL). `elsewhere` names another server. Every decision that asks whether a host is the
 * bundled container (start, stop, stored credentials, the built-in mode, the page's notes and restart list) must
 * answer the same for each.
 */
exports.HOST_SPELLINGS = {
    database: {
        reach: ['postgres', 'Postgres', 'postgres.', 'openwa-postgres', ' OPENWA-POSTGRES. '],
        elsewhere: ['localhost', 'postgres-replica', 'postgres.example.com', 'openwa-postgres-2', ''],
    },
    redis: {
        reach: ['redis', 'REDIS', 'redis.', 'openwa-redis'],
        elsewhere: ['localhost', 'redis-master', 'myredis', ''],
    },
    storage: {
        reach: [
            'http://minio:9000',
            'http://MINIO:9000',
            'http://minio:9000/',
            'http://openwa-minio:9000',
            'https://minio.:9000',
        ],
        elsewhere: ['http://localhost:9000', 'http://minio.example.com:9000', 'minio:9000', 'not a url', ''],
    },
};
