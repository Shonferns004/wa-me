"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.effectiveBuiltInFlag = effectiveBuiltInFlag;
exports.savedBuiltInMode = savedBuiltInMode;
const env_precedence_1 = require("../../config/env-precedence");
const docker_1 = require("../docker");
/**
 * The built-in (bundled container) mode the saved configuration states for each datastore, shared by
 * GET /infra/config and the Docker-unreachable fallback of GET /infra/status so the two cannot disagree.
 *
 * `flag` is what the dashboard saves, `host` is what the next boot connects to, `profile` names the bundled container
 * that host may reach, and `selection` is the file's own record that the service is in use at all.
 */
const SERVICES = {
    database: {
        flag: 'POSTGRES_BUILTIN',
        host: 'DATABASE_HOST',
        profile: 'postgres',
        selection: 'DATABASE_TYPE',
        selected: 'postgres',
    },
    redis: {
        flag: 'REDIS_BUILTIN',
        host: 'REDIS_HOST',
        profile: 'redis',
        selection: 'REDIS_ENABLED',
        selected: 'true',
    },
    storage: {
        flag: 'MINIO_BUILTIN',
        host: 'S3_ENDPOINT',
        profile: 'minio',
        selection: 'STORAGE_TYPE',
        selected: 's3',
    },
};
/** The flag value the next boot reads: the environment's when it pins the flag, else the file's. */
function flagValue(service, saved) {
    const flag = SERVICES[service].flag;
    return (0, env_precedence_1.isEnvPinned)(flag) ? process.env[flag] : saved[flag];
}
/**
 * The built-in flag the environment pins, else the saved one: this instance's own record that it chose the bundled
 * container. GET /infra/status falls back to it with Docker unreachable, where a host called postgres alone is as
 * likely an external server (a Kubernetes Service, say) and must not read as the bundled container; the flag alone
 * does not either, since the process dials its host.
 */
function effectiveBuiltInFlag(service, saved) {
    return flagValue(service, saved) === 'true';
}
/**
 * The next boot's host decides whether the service is built-in. A true flag starts the bundled container only
 * while its datastore is in use and the environment does not pin the host to another server.
 * Rules, in order:
 *  1. A host pinned by the environment (or the project .env) decides, as it does at boot and in
 *     requestRestart: the bundled host in any spelling that reaches the container is built-in, any other is
 *     not, and no saved flag can be a pending switch because the pin outranks it.
 *  2. Otherwise the file's host decides, and the flag counts as saved when the environment pins it, or when the file
 *     stores it for a service the file also selects. A flag that is not true beside the bundled host name in the file
 *     is no choice of an external service, though: the next boot dials the container, so it reads as built-in and
 *     nothing is saved.
 *  3. Otherwise there is nothing saved.
 */
function savedBuiltInMode(service, saved) {
    const spec = SERVICES[service];
    if ((0, env_precedence_1.isEnvPinned)(spec.host)) {
        return { builtIn: (0, docker_1.namesBundledContainer)(spec.profile, process.env[spec.host]), builtInSet: false };
    }
    const flagPinned = (0, env_precedence_1.isEnvPinned)(spec.flag);
    const flag = flagValue(service, saved);
    const selectedInFile = saved[spec.selection] === spec.selected;
    const dialsBundled = (0, docker_1.namesBundledContainer)(spec.profile, saved[spec.host]);
    if (flag !== 'true' && dialsBundled)
        return { builtIn: true, builtInSet: false };
    return { builtIn: dialsBundled, builtInSet: flag !== undefined && (flagPinned || selectedInFile) };
}
