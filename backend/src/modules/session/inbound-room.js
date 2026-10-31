"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InboundRoom = void 0;
exports.deferred = deferred;
exports.roomState = roomState;
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const engine_1 = require("../../engine");
function deferred() {
    let resolve;
    const promise = new Promise(r => (resolve = r));
    return { promise, resolve };
}
function roomState() {
    return { granted: false, abandoned: false, grant: deferred(), done: deferred(), holds: [] };
}
/**
 * Room for the downloaded payloads one session holds in memory before their rows are written:
 * INBOUND_MEDIA_CONCURRENCY slots of one payload each, granted in arrival order. A slot is held until
 * the row is written AND every hold settles, so a stalled insert keeps it, and the payloads held stay
 * within the slots however long the store takes.
 */
class InboundRoom {
    gate = new concurrency_limiter_1.ConcurrencyLimiter((0, engine_1.inboundMediaConcurrency)());
    lastRelease = Date.now();
    /** Queue `s` for a slot. Synchronous: a free slot is granted before this returns. */
    request(s) {
        return this.gate
            .run(async () => {
            if (s.abandoned)
                return;
            s.granted = true;
            s.grant.resolve(true);
            await s.done.promise;
            // Read after `done`, and to the end of the array: a hold pushed while an earlier one runs counts too.
            for (let i = 0; i < s.holds.length; i++)
                await s.holds[i];
        })
            .then(() => {
            this.lastRelease = Date.now();
        });
    }
    /**
     * Wait for the grant. Gives up only when the room made no progress (no slot released) for twice
     * MEDIA_DOWNLOAD_TIMEOUT_MS: a holder is legitimately busy for one download deadline plus its
     * commit, so a burst behind a moving room keeps its media, and only a stalled room sheds.
     */
    wait(s) {
        if (s.granted)
            return Promise.resolve(true);
        const window = 2 * (0, engine_1.inboundMediaTimeoutMs)();
        const asked = Date.now();
        const arm = (delay) => {
            const timer = setTimeout(() => {
                if (s.granted || s.abandoned)
                    return;
                const idle = Date.now() - Math.max(this.lastRelease, asked);
                if (idle < window)
                    return arm(window - idle);
                s.abandoned = true;
                s.grant.resolve(false);
            }, delay);
            timer.unref?.();
            void s.grant.promise.then(() => clearTimeout(timer));
        };
        arm(window);
        return s.grant.promise;
    }
    get idle() {
        return this.gate.activeCount === 0 && this.gate.queuedCount === 0;
    }
}
exports.InboundRoom = InboundRoom;
