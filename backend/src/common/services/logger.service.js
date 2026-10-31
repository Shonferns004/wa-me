"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var LoggerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoggerService = exports.UNPRINTABLE = exports.REDACTED = exports.isSecretName = exports.LogFormat = exports.LogLevel = void 0;
exports.writtenForm = writtenForm;
exports.redactSecrets = redactSecrets;
exports.logFormatFromEnv = logFormatFromEnv;
exports.applyLogLevelFromEnv = applyLogLevelFromEnv;
exports.createLogger = createLogger;
const node_util_1 = require("node:util");
const common_1 = require("@nestjs/common");
const request_context_1 = require("./request-context");
var LogLevel;
(function (LogLevel) {
    LogLevel["ERROR"] = "error";
    LogLevel["WARN"] = "warn";
    LogLevel["INFO"] = "info";
    LogLevel["DEBUG"] = "debug";
    LogLevel["VERBOSE"] = "verbose";
})(LogLevel || (exports.LogLevel = LogLevel = {}));
var LogFormat;
(function (LogFormat) {
    LogFormat["JSON"] = "json";
    LogFormat["PRETTY"] = "pretty";
})(LogFormat || (exports.LogFormat = LogFormat = {}));
// Defense-in-depth: redact the VALUES of secret-named keys before they reach the log sink, so a
// careless `logger.info('…', { password })` can't leak a credential. Matches the key NAME only
// (case-insensitive), never the value's content, to avoid false positives on innocuous fields.
const SECRET_KEY_PATTERN = /password|passwd|secret|token|api[-_]?key|authorization|credential|pepper|private[-_]?key/i;
// Metadata is copied whole down to this depth, however wide, which is where it normally lives; only REDACT_MAX_ENTRIES
// bounds that part. Below it one copy takes at most REDACT_DEEP_NODES more objects and arrays and writes the rest as
// [Truncated], never raw, so a densely linked object graph cannot make it walk that part for long.
const REDACT_FULL_DEPTH = 5;
const REDACT_DEEP_NODES = 1000;
// The copy of an array tests every index for a hole, so a sparse array costs its length however little it holds
// (2**32 - 1 takes tens of seconds). An array longer than this, or below the whole levels longer than what is left of
// the node budget, is written as [Truncated] before any index is visited. The same goes for a Map or a Set, by its
// size. Below the whole levels an object is listed, then truncated if its keys do not fit in what is left of the
// budget, which they are then charged to.
const REDACT_MAX_ARRAY_LENGTH = 1_000_000;
// One copy takes at most this many entries at every level: the keys of the objects and the length of the arrays it
// copies, a shared one charged again at every use, because every use is copied and written out again. It is twice the
// array limit, so an array, Set or object of that size is written whole; a Map is charged as the arrays it is written
// as, its list and a pair of two each, so three entries a pair, and one of more than 666,666 pairs is not. An object or
// array that does not fit in what is left of it is written as [Truncated], which is what keeps a few shared references
// from expanding into an unbounded copy.
const REDACT_MAX_ENTRIES = 2_000_000;
// A string is written whole and is not copied, so a long one referenced many times, or a long key name of a shared
// object, expands past what the entries count. One copy writes at most this many characters of string values, BigInt
// text (each digit charged REDACT_BIGINT_WEIGHT times) and key names, each charged again at every use; one that does
// not fit is written as [Truncated]. It is far above any line a caller writes on purpose (a million entries of 64
// characters fit), and below what V8 can build.
const REDACT_MAX_CHARS = 2 ** 26;
// Building the text of a BigInt costs more per digit the longer it is: about 20 times what writing a character of a
// string costs at 100,000 digits and 80 times at 4 million. So a BigInt of more than 2**22 digits does not fit even
// alone, and a line under 2**26 characters that holds one is still cut.
const REDACT_BIGINT_WEIGHT = 16;
/** Whether a key's name marks its value as a credential, and what is written in its place, unless told otherwise. */
const isSecretName = (key) => SECRET_KEY_PATTERN.test(key);
exports.isSecretName = isSecretName;
exports.REDACTED = '[REDACTED]';
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Int8Array.prototype);
/** The elements a typed array holds, read from the array itself, not from a `length` it claims. A DataView has none. */
function elementCount(view) {
    try {
        return Reflect.get(TYPED_ARRAY_PROTOTYPE, 'length', view);
    }
    catch {
        return 0;
    }
}
/** The moment a Date holds, read through the built-in methods rather than any the value defines itself. */
function dateText(date) {
    return Number.isNaN(Date.prototype.getTime.call(date)) ? 'Invalid Date' : Date.prototype.toISOString.call(date);
}
/** The value a boxed string, number or boolean holds, read through the built-in method of its brand. */
function boxedValue(node) {
    if (node_util_1.types.isStringObject(node))
        return String.prototype.valueOf.call(node);
    return node_util_1.types.isNumberObject(node) ? Number.prototype.valueOf.call(node) : Boolean.prototype.valueOf.call(node);
}
/**
 * The readable form a value takes, if any. It is told apart by its prototype, which costs little, and a Date, Map, Set
 * or boxed value then by its brand, which a value made from that prototype alone lacks. A Proxy is copied by its own
 * properties, also when its getPrototypeOf trap throws, and so is a value made in another realm.
 */
function formOf(node) {
    try {
        if (node instanceof Date)
            return node_util_1.types.isDate(node) ? 'date' : undefined;
        if (node instanceof Map)
            return node_util_1.types.isMap(node) ? 'map' : undefined;
        if (node instanceof Set)
            return node_util_1.types.isSet(node) ? 'set' : undefined;
        if (node instanceof String)
            return node_util_1.types.isStringObject(node) ? 'boxed' : undefined;
        if (node instanceof Number)
            return node_util_1.types.isNumberObject(node) ? 'boxed' : undefined;
        if (node instanceof Boolean)
            return node_util_1.types.isBooleanObject(node) ? 'boxed' : undefined;
        return node instanceof Error && !node_util_1.types.isProxy(node) ? 'error' : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * What one copy writes for an object before it copies its parts: a Date as its text, a boxed value as its value, a Map
 * as the array of its [key, value] pairs (a credential key's value replaced), a Set as the array of its values, a
 * typed array as its type and length and an Error as its name, message and stack before its own properties. Any other
 * object is returned as it is, to be copied by its own properties. The sandbox log relay measures a plugin's meta
 * through it, so the two write every form alike.
 */
function writtenForm(node, form = formOf(node), isSecretKey = exports.isSecretName, marker = exports.REDACTED) {
    if (form === 'date')
        return dateText(node);
    if (form === 'boxed')
        return boxedValue(node);
    if (form === 'map' || form === 'set') {
        const items = [];
        if (form === 'map')
            Map.prototype.forEach.call(node, (item, key) => {
                // A boxed string key is written as its text, so it is tested as that text.
                const name = typeof key === 'object' && key !== null && formOf(key) === 'boxed' ? boxedValue(key) : key;
                items.push([key, typeof name === 'string' && isSecretKey(name) ? marker : item]);
            });
        else
            Set.prototype.forEach.call(node, (item) => items.push(item));
        return items;
    }
    // A typed array, a Buffer included, is written as its type and the elements it holds, never one entry per element.
    // A DataView has no type of that kind and is copied as an object.
    const type = ArrayBuffer.isView(node) ? Reflect.get(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag, node) : 0;
    const props = typeof type === 'string'
        ? {
            type: Object.getPrototypeOf(node) === Buffer.prototype ? 'Buffer' : type,
            length: elementCount(node),
        }
        : node;
    if (form !== 'error')
        return props;
    const error = node;
    return { name: error.name, message: error.message, stack: error.stack, ...props };
}
/**
 * Return a copy of `value` with credential keys' values replaced by `[REDACTED]` (recursive). The copy always
 * serializes: an object met again inside itself becomes `[Circular]`, a nested BigInt its decimal text, and
 * whatever lies beyond the deep node, entry or character budget `[Truncated]`. A value whose data is not in its own
 * properties is written readably: an Error as its name, message and stack before its own properties, a Date as its ISO
 * text, a boxed string, number or boolean as its value, a Buffer or typed array as its type and length, a Map as the
 * array of its [key, value] pairs and a Set as the array of its values. Shared with the Baileys wire logger.
 */
function redactSecrets(value, options = {}) {
    const { isSecretKey = exports.isSecretName, marker = exports.REDACTED } = options;
    const budget = { nodes: REDACT_DEEP_NODES, entries: REDACT_MAX_ENTRIES, chars: REDACT_MAX_CHARS };
    const walk = (node, path) => {
        // A function is not data: it is left out, as JSON.stringify leaves it out of an object and writes null in an array.
        if (typeof node === 'function')
            return undefined;
        if (typeof node === 'string')
            return (budget.chars -= node.length) < 0 ? '[Truncated]' : node;
        if (node === null || typeof node !== 'object')
            return node;
        const form = formOf(node);
        // A Date and a boxed value are written as a primitive, charged like one.
        if (form === 'date' || form === 'boxed')
            return walk(writtenForm(node, form, isSecretKey, marker), path);
        if (path.includes(node))
            return '[Circular]';
        const deep = path.length >= REDACT_FULL_DEPTH;
        // A negative budget means something that did not fit was met: nothing else is copied or listed after it.
        if ((deep && --budget.nodes < 0) || budget.entries < 0 || budget.chars < 0)
            return '[Truncated]';
        const parents = [...path, node];
        const copy = (child) => {
            if (typeof child !== 'bigint')
                return walk(child, parents);
            // Its text costs far more to build than a string of that length costs to write (see REDACT_BIGINT_WEIGHT), and
            // none is built once the budget is spent.
            if (budget.chars < 0)
                return '[Truncated]';
            const text = child.toString();
            return (budget.chars -= text.length * REDACT_BIGINT_WEIGHT) < 0 ? '[Truncated]' : text;
        };
        const left = Math.min(budget.entries, deep ? budget.nodes : Infinity);
        const room = Math.min(left, REDACT_MAX_ARRAY_LENGTH);
        // A Map or a Set is copied as the array its form is; its size is held against the room before any entry is read.
        let list = node;
        const map = form === 'map';
        if (map || form === 'set') {
            if (Reflect.get(map ? Map.prototype : Set.prototype, 'size', node) > room)
                return '[Truncated]';
            list = writtenForm(node, form, isSecretKey, marker);
        }
        if (Array.isArray(list)) {
            // Read once and taken as a count (whole, from zero), as map takes it: one number gates the copy and sizes it.
            const length = Math.max(0, Math.trunc(list.length) || 0);
            if (length > room)
                return '[Truncated]';
            budget.entries -= length;
            // A plain Array filled by index, holes skipped: map would build it through the constructor of an Array subclass.
            const plain = new Array(length);
            for (let index = 0; index < length; index++)
                if (index in list)
                    plain[index] = copy(list[index]);
            return plain;
        }
        // A plain object, by far the most common, is its own form: the call is left out, as it costs an ordinary line.
        const source = (form === undefined && !ArrayBuffer.isView(node) ? node : writtenForm(node, form, isSecretKey, marker));
        const keys = Object.keys(source);
        if (keys.length > left) {
            // Listed once, then charged: another reference to this object, or any other node, is refused without listing.
            budget.nodes -= keys.length;
            budget.entries -= keys.length;
            return '[Truncated]';
        }
        budget.entries -= keys.length;
        const out = {};
        for (const key of keys) {
            // The key that does not fit turns its object into the marker; keys after the budget is spent are only listed.
            if (budget.chars >= 0 && (budget.chars -= key.length) < 0)
                return '[Truncated]';
            const val = source[key];
            // JSON.stringify would call an own toJSON on the copy and write whatever it returns, redacted or not.
            if (key === 'toJSON' && typeof val === 'function')
                continue;
            const written = isSecretKey(key) ? marker : copy(val);
            // Assigning to __proto__ would set the prototype of the copy; an own property of that name is defined instead.
            if (key === '__proto__')
                Object.defineProperty(out, key, { value: written, enumerable: true, writable: true, configurable: true });
            else
                out[key] = written;
        }
        return out;
    };
    return walk(value, []);
}
/** Written in place of a message or trace that cannot be read. */
exports.UNPRINTABLE = '[Unprintable]';
/**
 * What a value that could not be turned into JSON is written as: a primitive as it prints, anything else not at all.
 * The text an object or a function gives for itself (its own toString, a function's source) never went through the
 * redaction, so it is not used.
 */
function plainText(value) {
    return value === null || (typeof value !== 'object' && typeof value !== 'function') ? String(value) : exports.UNPRINTABLE;
}
/** A non-string, non-Error message as one line of text (redacted like metadata, never throwing). */
function stringifyMessage(message) {
    try {
        return JSON.stringify(redactSecrets(message)) ?? plainText(message);
    }
    catch {
        return plainText(message);
    }
}
// ANSI color codes — mirrors the palette NestJS's built-in ConsoleLogger uses so our
// pretty output blends in with the framework's own `[Nest] … LOG [Context]` lines.
const ANSI = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};
const LEVEL_COLOR = {
    [LogLevel.ERROR]: ANSI.red,
    [LogLevel.WARN]: ANSI.yellow,
    [LogLevel.INFO]: ANSI.green,
    [LogLevel.DEBUG]: ANSI.magenta,
    [LogLevel.VERBOSE]: ANSI.cyan,
};
// NestJS prints `info` as `LOG`; match its labels so both log sources line up.
const LEVEL_LABEL = {
    [LogLevel.ERROR]: 'ERROR',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.INFO]: 'LOG',
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.VERBOSE]: 'VERBOSE',
};
// Keys that are rendered in the line prefix rather than the trailing metadata.
const STRUCTURAL_KEYS = new Set(['timestamp', 'level', 'context', 'message', 'trace']);
let LoggerService = class LoggerService {
    static { LoggerService_1 = this; }
    context = 'Application';
    static logLevel = LogLevel.INFO;
    static logFormat = null;
    static setLogLevel(level) {
        LoggerService_1.logLevel = level;
    }
    // Explicitly pin the output format. When unset, the format is resolved from
    // LOG_FORMAT / TTY detection (see resolveFormat).
    static setLogFormat(format) {
        LoggerService_1.logFormat = format;
    }
    setContext(context) {
        this.context = context;
    }
    // Messages and traces are `unknown` because this is also Nest's framework logger (main.ts), and Nest
    // passes the thrown Error itself as the message of an unhandled-exception line; writeLog normalizes.
    // `fields` are the caller's own, written beside metadata that came from elsewhere (a plugin's id beside its meta).
    log(message, context, fields) {
        this.writeLog(LogLevel.INFO, message, context, undefined, fields);
    }
    error(message, trace, context, fields) {
        this.writeLog(LogLevel.ERROR, message, context, trace, fields);
    }
    fatal(message, context) {
        this.writeLog(LogLevel.ERROR, message, context);
    }
    warn(message, context, fields) {
        this.writeLog(LogLevel.WARN, message, context, undefined, fields);
    }
    debug(message, context, fields) {
        this.writeLog(LogLevel.DEBUG, message, context, undefined, fields);
    }
    verbose(message, context) {
        this.writeLog(LogLevel.VERBOSE, message, context);
    }
    writeLog(level, rawMessage, context, rawTrace, fields) {
        if (!this.shouldLog(level))
            return;
        // The message and trace are whatever the caller (or Nest) handed over, so reading them is guarded like the metadata.
        let message;
        try {
            // An Error serializes to `{}`, so take its message and stack apart instead of losing both.
            if (rawMessage instanceof Error) {
                rawTrace ??= rawMessage.stack;
                rawMessage = rawMessage.message;
            }
            message = typeof rawMessage === 'string' ? rawMessage : stringifyMessage(rawMessage);
        }
        catch {
            message = exports.UNPRINTABLE;
        }
        let trace;
        try {
            // An Error's stack is text unless something replaced it; anything that is not text is redacted like metadata.
            const text = rawTrace instanceof Error ? (rawTrace.stack ?? rawTrace.message) : rawTrace;
            trace = text === undefined || typeof text === 'string' ? text : stringifyMessage(text);
        }
        catch {
            trace = exports.UNPRINTABLE;
        }
        const timestamp = new Date().toISOString();
        const contextName = typeof context === 'string' ? context : this.context;
        // Stamp every log line with the active request id (set by requestContextMiddleware) so a request
        // can be traced across logs. Absent outside a request scope (boot, workers, cron).
        const requestId = (0, request_context_1.getRequestId)();
        const render = (metadata) => {
            // Caller metadata never replaces the structural fields: a plugin's ctx.logger meta arrives here
            // verbatim, and a `level`, `context` or `message` key in it would otherwise forge the whole line.
            const logEntry = {
                timestamp,
                level,
                context: contextName,
                message,
                ...Object.fromEntries(Object.entries(metadata).filter(([key]) => !STRUCTURAL_KEYS.has(key) && key !== 'requestId')),
                ...(trace !== undefined ? { trace } : {}),
                ...(requestId ? { requestId } : {}),
            };
            return LoggerService_1.resolveFormat() === LogFormat.PRETTY
                ? this.formatPretty(level, logEntry)
                : JSON.stringify(logEntry);
        };
        // The caller's own fields are copied apart, so they stay on the line when the metadata is cut or cannot be read. Nest
        // appends its context name to the arguments of a Logger it made, which is not a record.
        const own = typeof fields === 'object' && fields !== null;
        let added = {};
        let output;
        try {
            if (own)
                added = redactSecrets(fields);
            const copy = typeof context === 'object' && context !== null ? redactSecrets(context) : {};
            // An array over the length limit comes back as the marker text: one field, not a record to spread.
            const metadata = typeof copy === 'string' ? { metadata: copy } : copy;
            output = render(own ? { ...metadata, ...added } : metadata);
        }
        catch {
            // A getter or proxy trap in the caller's metadata threw. The line is still worth writing, without that metadata.
            output = render({ metadata: '[Unreadable]', ...added });
        }
        switch (level) {
            case LogLevel.ERROR:
                console.error(output);
                break;
            case LogLevel.WARN:
                console.warn(output);
                break;
            default:
                console.log(output);
        }
    }
    // Render a single entry as a human-readable line in the same shape NestJS's ConsoleLogger uses
    // (so it lines up with the framework's own output), but tagged honestly as [OpenWA]:
    //   [OpenWA] 1896  - 25/06/2026, 4:59:22 PM     LOG [AuthService] API Docs: … sessionId=abc
    formatPretty(level, entry) {
        const useColor = LoggerService_1.colorEnabled();
        const paint = (code, text) => (useColor ? `${code}${text}${ANSI.reset}` : text);
        const levelColor = LEVEL_COLOR[level];
        const label = LEVEL_LABEL[level].padStart(7);
        const timestamp = new Date(String(entry.timestamp)).toLocaleString();
        const contextName = String(entry.context);
        const message = String(entry.message);
        // Trailing structured metadata (sessionId, action, duration, …) shown dimmed as key=value pairs.
        const formatValue = (value) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
        const meta = Object.entries(entry)
            .filter(([key, value]) => !STRUCTURAL_KEYS.has(key) && value !== undefined)
            .map(([key, value]) => `${key}=${formatValue(value)}`)
            .join(' ');
        let line = `${paint(levelColor, `[OpenWA] ${process.pid}  -`)} ${timestamp} ` +
            `${paint(levelColor, label)} ${paint(ANSI.yellow, `[${contextName}]`)} ${paint(levelColor, message)}`;
        if (meta) {
            line += ` ${paint(ANSI.dim, meta)}`;
        }
        // Error stack traces print on their own line(s), like NestJS.
        if (typeof entry.trace === 'string' && entry.trace) {
            line += `\n${paint(levelColor, entry.trace)}`;
        }
        return line;
    }
    static resolveFormat() {
        return LoggerService_1.logFormat ?? logFormatFromEnv();
    }
    static colorEnabled() {
        // Honor the de-facto NO_COLOR / FORCE_COLOR conventions; otherwise colorize only a real TTY.
        if (process.env.NO_COLOR)
            return false;
        if (process.env.FORCE_COLOR)
            return true;
        return Boolean(process.stdout.isTTY);
    }
    shouldLog(level) {
        const levels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG, LogLevel.VERBOSE];
        const currentIndex = levels.indexOf(LoggerService_1.logLevel);
        const targetIndex = levels.indexOf(level);
        return targetIndex <= currentIndex;
    }
};
exports.LoggerService = LoggerService;
exports.LoggerService = LoggerService = LoggerService_1 = __decorate([
    (0, common_1.Injectable)({ scope: common_1.Scope.TRANSIENT })
], LoggerService);
/**
 * The format LOG_FORMAT selects, read per write: `json` or `pretty` in any case and padding. Anything
 * else, unset included, is the NODE_ENV default.
 */
function logFormatFromEnv(env = process.env) {
    const explicit = env.LOG_FORMAT?.trim().toLowerCase();
    if (explicit === LogFormat.JSON || explicit === LogFormat.PRETTY) {
        return explicit;
    }
    // No explicit choice: structured JSON in production (containers, log aggregators),
    // human-readable pretty everywhere else. This mirrors NestJS's own logger, which
    // always prints its text format, and unlike a TTY check it stays correct when
    // stdout is piped through a dev runner (e.g. `concurrently` in `npm run dev`).
    return env.NODE_ENV === 'production' ? LogFormat.JSON : LogFormat.PRETTY;
}
/**
 * Apply LOG_LEVEL as boot reads it: trimmed, lower-cased, and only a level this logger knows. A
 * misspelling is skipped here and refused by validateEnv with its own message. Shared by the env
 * loader and main.ts so the two cannot read the variable differently.
 */
function applyLogLevelFromEnv(raw = process.env.LOG_LEVEL) {
    const requested = raw?.trim().toLowerCase();
    if (requested && Object.values(LogLevel).includes(requested)) {
        LoggerService.setLogLevel(requested);
    }
}
// Create a factory for easy instantiation
function createLogger(context) {
    const logger = new LoggerService();
    logger.setContext(context);
    return logger;
}
