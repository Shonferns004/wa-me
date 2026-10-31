"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBodyLimitBytes = parseBodyLimitBytes;
exports.resolveInflightBodyBudgetBytes = resolveInflightBodyBudgetBytes;
exports.createInflightBodyBudget = createInflightBodyBudget;
const bootstrap_security_1 = require("./bootstrap-security");
const ip_1 = require("../common/utils/ip");
/**
 * Default budget = 4 × the per-request body cap: a handful of concurrent full-size media uploads
 * (base64 rides in the JSON body) still fits, while the worst-case aggregate (~100 MiB with the
 * default 25 MiB cap) stays small next to a 2 GiB container limit and realistic concurrency.
 */
const DEFAULT_BUDGET_MULTIPLIER = 4;
/** Binary units, mirroring the semantics of the `bytes` package the body parser uses. */
const UNIT_BYTES = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
    pb: 1024 ** 5,
};
const FALLBACK_LIMIT_BYTES = 25 * UNIT_BYTES.mb;
/**
 * Stall reaper. A reservation is normally released when the response finishes or the connection
 * dies — but a socket that sends headers and then goes silent fires NEITHER, so without a reaper
 * it would hold its declared bytes until Node's requestTimeout (5 minutes by default), and four
 * such connections at the per-request cap would pin the entire default budget, renewable forever.
 * Any admitted request expecting a body is therefore polled: if no new body bytes arrive for
 * STALL_TIMEOUT_MS the socket is destroyed and the reservation released. Polling (rather than one
 * fixed deadline) lets any progress reset the clock, so slow-but-moving uploads are not dropped.
 */
const STALL_TIMEOUT_MS = 15_000;
const STALL_POLL_MS = 5_000;
/** Node's default server.requestTimeout, used when the caller does not pass REQUEST_TIMEOUT_MS. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
/**
 * What a chunked (undeclared-length) body reserves at admission. It is a floor: the same poll that
 * watches for a stall raises the reservation to the bytes received (`socket.bytesRead`) once they
 * exceed it, and a smaller body keeps this placeholder until the request is released. It only has to
 * be big enough that admission control is not a free-for-all, not big enough to price a small upload
 * out of the budget.
 */
const UNDECLARED_OPENING_RESERVATION_BYTES = 1024 * 1024;
/**
 * Parse a body-limit string ('25mb', '1024', '1.5gb') into bytes. Only the formats
 * resolveBodyLimit accepts are supported, which keeps this module self-contained (no extra
 * dependency); an impossible mismatch falls back to the same 25 MiB default instead of throwing.
 */
function parseBodyLimitBytes(limit) {
    const match = /^(\d+(?:\.\d+)?)\s?(b|kb|mb|gb|tb|pb)?$/i.exec(limit.trim());
    if (!match)
        return FALLBACK_LIMIT_BYTES;
    return Math.floor(parseFloat(match[1]) * UNIT_BYTES[(match[2] ?? 'b').toLowerCase()]);
}
/**
 * Resolve the aggregate budget in bytes. An explicit INFLIGHT_BODY_BUDGET_BYTES (positive integer)
 * wins; an invalid one falls back to the default — env.validation already rejects it at boot, so
 * this is the same fail-safe layering as the other byte knobs. The default scales with
 * BODY_SIZE_LIMIT so tuning the per-request cap keeps the aggregate proportional.
 */
function resolveInflightBodyBudgetBytes(budgetEnv, bodyLimitEnv) {
    const raw = budgetEnv?.trim();
    if (raw) {
        const explicit = Number(raw);
        if (Number.isInteger(explicit) && explicit > 0)
            return explicit;
    }
    return DEFAULT_BUDGET_MULTIPLIER * parseBodyLimitBytes((0, bootstrap_security_1.resolveBodyLimit)(bodyLimitEnv));
}
/** Share of the budget open to requests without a recognised API key (see the classify option). */
const ANONYMOUS_POOL_FRACTION = 0.25;
function createInflightBodyBudget(budgetBytes, options) {
    let inFlightBytes = 0;
    const retryAfter = String(options?.retryAfterSeconds ?? 1);
    const trustedProxies = options?.trustedProxies ?? [];
    const share = Math.min(1, Math.max(Number.EPSILON, options?.perClientShare ?? 0.5));
    const perClientCap = Math.max(1, Math.floor(budgetBytes * share));
    const classify = options?.classify;
    const bodyLimitBytes = options?.bodyLimitBytes ?? FALLBACK_LIMIT_BYTES;
    const requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // The anonymous pool holds at least two full-size bodies, so with the default half share one
    // client never fills it and other unkeyed senders, ingress deliveries among them, keep room. A
    // budget below three body caps leaves keyed traffic less than a full-size body, which the docs
    // call out.
    const anonPool = Math.min(budgetBytes, Math.max(2 * bodyLimitBytes, Math.floor(budgetBytes * ANONYMOUS_POOL_FRACTION)));
    const anonClientCap = Math.max(Math.min(bodyLimitBytes, anonPool), Math.floor(anonPool * share));
    let anonInFlight = 0;
    // Per-client in-flight bytes, keyed on the resolved client IP (an IPv6 client on its /64).
    // Entries are created lazily and deleted by the same exactly-once release that decrements the
    // aggregate, so the map cannot leak a client that finished. Only body-carrying requests are
    // tracked. A cap on the MAP itself guards the pathological many-spoofed-IPs case: past it, a NEW
    // client key sending a body is treated as busiest (refused) rather than evicting a live one -
    // refusing beats corrupting another client's accounting. Bodyless requests (GETs, health
    // probes) never touch the map, so a full map cannot refuse them.
    const clientInFlight = new Map();
    const MAX_TRACKED_CLIENTS = 10_000;
    // Opening reservation for a body with no declared length (chunked). It is only a floor: the
    // poller below raises it to the bytes that actually arrive, so a small chunked request costs this
    // placeholder rather than a whole per-request slot. Reserving a whole per-request cap up front
    // instead would make the budget a concurrency limit of DEFAULT_BUDGET_MULTIPLIER for chunked
    // senders — four 6-byte uploads would refuse every further body-carrying request.
    const undeclaredReservation = Math.max(1, Math.min(UNDECLARED_OPENING_RESERVATION_BYTES, budgetBytes));
    // The rejected request's body is deliberately NEVER read. 'Connection: close' tells the client
    // (and Node) this socket dies with the response, so the unread bytes are discarded with the
    // socket instead of being misread as the next pipelined request on a keep-alive connection.
    const rejectBusy = (req, res) => {
        // Another listener may already have started an early response (e.g. a guard's 401 flushing
        // while the body still streams in); writing the 503 then throws ERR_HTTP_HEADERS_SENT from
        // inside a raw listener. Dropping the socket is the only safe rejection left.
        if (res.headersSent || res.writableEnded) {
            req.destroy();
            return;
        }
        res.status(503).set('Retry-After', retryAfter).set('Connection', 'close').json({
            statusCode: 503,
            message: 'Too much request body data in flight; retry later',
            error: 'Service Unavailable',
        });
    };
    /** Same never-read-the-body disposal as rejectBusy; only the reason and status differ. */
    const rejectCompressed = (req, res) => {
        if (res.headersSent || res.writableEnded) {
            req.destroy();
            return;
        }
        res.status(415).set('Connection', 'close').json({
            statusCode: 415,
            message: 'Compressed request bodies are not supported',
            error: 'Unsupported Media Type',
        });
    };
    /** Same disposal again, for a body that could not be admitted even with nothing else in flight. */
    const rejectTooLarge = (req, res) => {
        if (res.headersSent || res.writableEnded) {
            req.destroy();
            return;
        }
        res.status(413).set('Connection', 'close').json({
            statusCode: 413,
            message: 'Request body exceeds what this server can accept',
            error: 'Payload Too Large',
        });
    };
    const middleware = (req, res, next) => {
        const declared = parseDeclaredLength(req.headers['content-length']);
        // A body with no declared length is expected only when the request is chunk-encoded (Node
        // ignores close-delimited request bodies on keep-alive HTTP/1.1). Anything else — GETs,
        // health checks, Content-Length: 0 — reserves nothing and is never reaped.
        // It is never refused or tracked either: see the early return below the encoding guard.
        let reserved = declared ?? (req.headers['transfer-encoding'] !== undefined ? undeclaredReservation : 0);
        // Every quantity this budget works with — the declared length, and socket.bytesRead in the
        // reconciler below — is a WIRE measurement, while what the budget exists to bound is HEAP. The
        // two are the same size only while the body is stored as it arrives. A compressed body breaks
        // that: it is admitted on its compressed length and then inflated by the parser, so a payload
        // orders of magnitude larger than the whole budget can be buffered without the accounting ever
        // seeing it. Refusing here — before admission, before a byte is read — keeps the invariant
        // true rather than trying to price an expansion that is not knowable in advance.
        //
        // The predicate is body-parser's, NOT `reserved > 0`. They disagree on exactly the cases that
        // matter: `parseDeclaredLength` rejects a Content-Length that is not a safe integer (reserving
        // nothing), while type-is `hasBody` accepts anything non-NaN — so `Content-Length: 2**53 + 1`
        // with a gzip body reserves 0 here yet is still handed to the parser. Mirroring hasBody keeps
        // the two layers from disagreeing about whether a body exists.
        const bodyIndicated = req.headers['transfer-encoding'] !== undefined || !Number.isNaN(Number(req.headers['content-length']));
        // The accepted set is body-parser's, deliberately: it compares the WHOLE header against
        // 'identity', so even a technically-uncompressed list ("identity, identity") is refused there.
        // Accepting more here would only move the refusal to the parser, which answers a different
        // shape — the two layers agreeing matters more than honouring an encoding list nobody sends.
        const encoding = (req.headers['content-encoding'] ?? '').trim().toLowerCase();
        if (bodyIndicated && encoding !== '' && encoding !== 'identity') {
            rejectCompressed(req, res);
            return;
        }
        // Nothing to reserve, so nothing to refuse, track or reap. This must stay BELOW the encoding
        // guard: a compressed body with a zero or unusable Content-Length reserves 0 yet still gets 415.
        if (reserved === 0) {
            next();
            return;
        }
        // Admission control on the RESERVED size: a request that would push the aggregate OR ITS
        // CLIENT'S SHARE past the budget is refused before a single byte of its body is buffered.
        // The per-client share bounds what one source can hold.
        // A recognised key is shared per key (its entries are bounded by the key count, so they are
        // exempt from the map cap); anything else per client IP.
        const clientIp = (0, ip_1.resolveClientIp)(req, trustedProxies);
        const keyId = classify?.(req, clientIp);
        const anonymous = classify !== undefined && keyId === undefined;
        const clientKey = keyId !== undefined ? `key:${keyId}` : (0, ip_1.limiterKeyForIp)(clientIp);
        const shareCap = anonymous ? anonClientCap : perClientCap;
        const ceiling = anonymous ? bodyLimitBytes : Infinity;
        const clientBusy = clientInFlight.get(clientKey) ?? 0;
        const mapAtCapacity = keyId === undefined && clientInFlight.size >= MAX_TRACKED_CLIENTS && !clientInFlight.has(clientKey);
        // The aggregate check uses the full declared size; the tier and share checks the charged size.
        const charge = Math.min(reserved, ceiling);
        // A declared body that would be refused on an idle server can never be admitted, so a retryable
        // 503 would only invite the client (and the SDKs, which retry a 503) to send it again. A chunked
        // body is refused on its placeholder, not its size, so it keeps the 503.
        if (declared !== undefined && (declared > budgetBytes || charge > shareCap || (anonymous && charge > anonPool))) {
            rejectTooLarge(req, res);
            return;
        }
        if (inFlightBytes + reserved > budgetBytes ||
            clientBusy + charge > shareCap ||
            (anonymous && anonInFlight + charge > anonPool) ||
            mapAtCapacity) {
            rejectBusy(req, res);
            return;
        }
        reserved = charge;
        inFlightBytes += reserved;
        if (anonymous)
            anonInFlight += reserved;
        clientInFlight.set(clientKey, clientBusy + reserved);
        let released = false;
        let stallTimer;
        const disarmStallReaper = () => {
            if (stallTimer === undefined)
                return;
            clearInterval(stallTimer);
            stallTimer = undefined;
        };
        // Exactly-once release: the first terminal event wins: normal completion (res 'finish'),
        // client/socket abort (req/res 'close'), stream failure (req/res 'error'). An aborted upload
        // typically fires several of these; the flag guarantees the aggregate is decremented once.
        const release = () => {
            if (released)
                return;
            released = true;
            disarmStallReaper();
            inFlightBytes -= reserved;
            if (anonymous)
                anonInFlight -= reserved;
            const busy = (clientInFlight.get(clientKey) ?? reserved) - reserved;
            if (busy > 0)
                clientInFlight.set(clientKey, busy);
            else
                clientInFlight.delete(clientKey);
        };
        res.on('finish', release);
        res.on('close', release);
        res.on('error', release);
        req.on('close', release);
        req.on('error', release);
        // Stall reaper (see STALL_TIMEOUT_MS above). Progress is measured on the SOCKET byte counter,
        // never on the request stream: attaching a 'data' listener would switch the stream to flowing
        // mode and eat chunks before a late consumer (the async guards run before busboy/body-parser
        // attach) ever sees them. 'end' is safe to observe (it does not start the flow) and disarms
        // the reaper once the real consumer finished reading.
        const socket = req.socket;
        const startBytes = socket.bytesRead;
        let lastBytes = startBytes;
        const admittedAt = Date.now();
        let lastProgress = admittedAt;
        // A declared body keeps its declared size until it is released. A chunked body is re-priced at
        // the bytes that have arrived, never below its opening placeholder: budget handed back mid-stream
        // would be taken back, unchecked, by a body that then completes between polls. The floor holds
        // after completion too, because bytes that arrived in the same read as the headers were already
        // counted in startBytes, so a small body sent with its headers measures as 0 while the handler
        // still holds it. Growth that crosses the aggregate, the client share or the anonymous pool
        // aborts the request mid-stream, the same bound a declared length gets at admission. A complete
        // body is never aborted: it is already buffered. reserved is updated BEFORE release() so the
        // exactly-once decrement subtracts the reconciled size.
        const reconcile = (complete) => {
            if (released || declared !== undefined)
                return;
            const actual = Math.min(Math.max(undeclaredReservation, socket.bytesRead - startBytes), ceiling);
            const delta = actual - reserved;
            if (delta === 0)
                return;
            inFlightBytes += delta;
            if (anonymous)
                anonInFlight += delta;
            reserved = actual;
            const busy = (clientInFlight.get(clientKey) ?? 0) + delta;
            clientInFlight.set(clientKey, busy);
            const overTier = anonymous && anonInFlight > anonPool;
            if (!complete && delta > 0 && (busy > shareCap || inFlightBytes > budgetBytes || overTier)) {
                release();
                req.destroy();
            }
        };
        const settle = () => {
            reconcile(true);
            disarmStallReaper();
        };
        stallTimer = setInterval(() => {
            // The whole message is in (Node parsed it to the end), so there is nothing left to stall on,
            // whether or not any consumer has read it. Without this a body that arrived in one segment
            // before this middleware ran would keep the reaper armed on a byte counter that can no
            // longer move, and a handler slower than STALL_TIMEOUT_MS would be killed mid-work.
            if (req.complete) {
                settle();
                return;
            }
            reconcile(false);
            if (released)
                return;
            const readNow = socket.bytesRead;
            // Pace reap. A body must keep up with the rate that lands what it holds inside the request
            // timeout, measured from admission after a STALL_TIMEOUT_MS grace: its declared size, or for
            // a chunked body its current reservation (the placeholder until more than that has arrived,
            // then the arrived bytes, which always meet the target). A steady sender that falls behind
            // would be cut off by the timeout anyway. One that starts slow and speeds up can be dropped
            // even though it would have finished in time; that is the accepted cost of not letting a
            // trickle hold its reservation for the whole timeout. A fully-arrived body always meets the
            // target.
            if (requestTimeoutMs > 0) {
                const target = declared ?? reserved;
                const paced = (target * (Date.now() - admittedAt - STALL_TIMEOUT_MS)) / requestTimeoutMs;
                if (readNow - startBytes < Math.min(target, paced)) {
                    release();
                    req.destroy();
                    return;
                }
            }
            if (readNow !== lastBytes) {
                lastBytes = readNow;
                lastProgress = Date.now();
                // The whole declared body has arrived; nothing left to stall on.
                if (declared !== undefined && readNow - startBytes >= declared)
                    disarmStallReaper();
                return;
            }
            if (Date.now() - lastProgress >= STALL_TIMEOUT_MS) {
                release();
                req.destroy();
            }
        }, STALL_POLL_MS);
        stallTimer.unref();
        req.on('end', settle);
        next();
    };
    return {
        middleware,
        currentBytes: () => inFlightBytes,
        clientBytes: req => clientInFlight.get((0, ip_1.limiterKeyForIp)((0, ip_1.resolveClientIp)(req, trustedProxies))) ?? 0,
        anonymousBytes: () => anonInFlight,
    };
}
/** A well-formed Content-Length, or undefined when absent/unusable (then reserve one slot if chunk-encoded). */
function parseDeclaredLength(raw) {
    if (raw === undefined)
        return undefined;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
