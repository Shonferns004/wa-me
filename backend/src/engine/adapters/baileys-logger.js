"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSilentLogger = createSilentLogger;
exports.createBaileysLogger = createBaileysLogger;
const logger_service_1 = require("../../common/services/logger.service");
/** Fully silent logger so Baileys does not spam stdout; diagnostics flow via connection.update. */
function createSilentLogger() {
    const noop = () => { };
    const logger = {
        level: 'silent',
        child: () => logger,
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
    };
    return logger;
}
/** Keys whose value is a credential wherever it appears in a record the library hands over. */
const SECRET_KEYS = new Set(['password', 'secret', 'token', 'apikey', 'api_key', 'authorization']);
/**
 * How a library record is redacted before it is serialised.
 *
 * Baileys hands this logger whatever object the failure carried, and a `socks` connect error carries
 * the whole proxy config, password included, as its only enumerable property. At debug level that
 * went to stdout verbatim, which on a shipped deployment means the proxy password in the container
 * log. An Error's message and stack are not enumerable, so they are copied explicitly: they are what
 * an operator raised the log level to see. The copy is bounded in the entries and characters it takes, and below
 * the fifth level in the objects too (see redactSecrets), because a logger must not walk an arbitrary graph on the
 * wire path.
 */
const REDACTION = {
    isSecretKey: key => SECRET_KEYS.has(key.toLowerCase()),
    marker: '[redacted]',
};
const BAILEYS_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
/**
 * Baileys logger, silent by default. Set `BAILEYS_LOG_LEVEL` (trace|debug|info|warn|error) to surface
 * Baileys' own diagnostics - the history/app-state sync decision flow ("awaiting notification", "App
 * state sync complete", MAC errors) at debug/info, and the raw decoded WA wire frames at trace. Emits
 * JSON lines to stdout (context "baileys-wire") independent of the app log level, so a run can be
 * captured with `BAILEYS_LOG_LEVEL=trace node dist/main > baileys-wire.log`.
 */
function createBaileysLogger() {
    const configured = (process.env.BAILEYS_LOG_LEVEL ?? 'silent').toLowerCase();
    if (!BAILEYS_LOG_LEVELS.includes(configured)) {
        return createSilentLogger();
    }
    const threshold = BAILEYS_LOG_LEVELS.indexOf(configured);
    const write = (lvl) => (obj, msg) => {
        if (BAILEYS_LOG_LEVELS.indexOf(lvl) < threshold) {
            return;
        }
        const head = { ts: new Date().toISOString(), level: lvl, context: 'baileys-wire' };
        let line;
        try {
            // An array over the length limit comes back as the marker text: one field, not a record to spread.
            const copy = typeof obj === 'string' ? undefined : (0, logger_service_1.redactSecrets)(obj, REDACTION);
            const rec = typeof obj === 'string'
                ? { msg: obj }
                : {
                    ...(typeof copy === 'string' ? { metadata: copy } : copy),
                    ...(msg ? { msg } : {}),
                };
            line = JSON.stringify({ ...head, ...rec });
        }
        catch {
            // A getter or proxy trap in the record threw. This runs inside Baileys and must not throw: write the message alone.
            line = JSON.stringify({ ...head, ...(msg ? { msg } : {}), metadata: '[Unreadable]' });
        }
        process.stdout.write(line + '\n');
    };
    const logger = {
        level: configured,
        child: () => logger,
        trace: write('trace'),
        debug: write('debug'),
        info: write('info'),
        warn: write('warn'),
        error: write('error'),
    };
    return logger;
}
