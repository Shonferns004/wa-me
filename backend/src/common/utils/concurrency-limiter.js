"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConcurrencyLimiter = void 0;
/**
 * Minimal async concurrency gate: runs at most `max` tasks concurrently, queueing the rest (FIFO).
 * Used to bound how many inbound media downloads run at once — each materializes a full decrypted
 * buffer in heap, so an unbounded fire-and-forget loop lets a sender flood the gateway with N parallel
 * multi-MB allocations. No external dependency (the codebase ships no p-limit/semaphore).
 */
class ConcurrencyLimiter {
    max;
    maxQueued;
    active = 0;
    waiters = [];
    /** Waiters taking back a slot they gave up in yieldSlot: already admitted, so outside `maxQueued`. */
    reacquiring = 0;
    closed = false;
    /**
     * `max` is clamped to at least 1 so a misconfigured 0/negative value never deadlocks the gate.
     * `maxQueued` bounds how many tasks may PARK waiting for a slot; an (active + queued)th arrival is
     * rejected (throws) instead of parking forever — this caps in-heap state under a burst, since each
     * parked closure holds its task (and an inbound media buffer) alive. Default Infinity preserves the
     * original unbounded-queue behavior for callers that don't opt into a cap.
     */
    constructor(max, maxQueued = Infinity) {
        this.max = max;
        this.maxQueued = maxQueued;
        this.max = Math.max(1, Math.floor(max));
        this.maxQueued = Math.max(0, Math.floor(maxQueued));
    }
    /** Slots the limiter runs at once (after clamping). */
    get maxCount() {
        return this.max;
    }
    /** Tasks currently holding a slot (running). */
    get activeCount() {
        return this.active;
    }
    /** Tasks parked waiting for a slot. */
    get queuedCount() {
        return this.waiters.length;
    }
    /** The part of {@link queuedCount} taking back a slot given up in yieldSlot (already admitted). */
    get reacquiringCount() {
        return this.reacquiring;
    }
    /**
     * Stop admitting work: every parked task is rejected (its run() promise throws 'ConcurrencyLimiter
     * closed') and every future run() rejects the same way, so a shutdown path can drain instead of
     * leaving parked closures to vanish silently. In-flight tasks are NOT interrupted — they finish
     * (or fail) normally; watch {@link activeCount} to await them.
     */
    close() {
        this.closed = true;
        const parked = this.waiters.splice(0);
        for (const wake of parked) {
            wake(new Error('ConcurrencyLimiter closed'));
        }
    }
    /**
     * Run `task` once a slot is free. The task receives `yieldSlot(fn)`, which gives the slot up for
     * the duration of `fn` and takes one again before returning, so a task that has to wait (a retry
     * backoff) does not hold a slot it is not using. Taking the slot back is exempt from `maxQueued`
     * and does not count against it, since the task was already admitted, and rejects with
     * 'ConcurrencyLimiter closed' once the limiter is closed. Callers that never wait can ignore the argument.
     */
    async run(task) {
        // Awaited only when parked: a free slot starts the task synchronously, as callers rely on.
        const parked = this.acquire(true);
        if (parked)
            await parked;
        let held = true;
        const yieldSlot = async (fn) => {
            if (!held)
                return fn();
            held = false;
            this.release();
            try {
                return await fn();
            }
            finally {
                const reparked = this.acquire(false);
                if (reparked) {
                    this.reacquiring++;
                    try {
                        await reparked;
                    }
                    finally {
                        this.reacquiring--;
                    }
                }
                held = true;
            }
        };
        try {
            return await task(yieldSlot);
        }
        finally {
            // A failed re-acquire leaves nothing to release: releasing anyway would hand a waiter a slot
            // this task no longer holds, or push the count below zero.
            if (held)
                this.release();
        }
    }
    /** Take a free slot (returns undefined) or park for one (returns the promise to await). */
    acquire(bounded) {
        if (this.closed) {
            throw new Error('ConcurrencyLimiter closed');
        }
        if (this.active < this.max) {
            this.active++;
            return undefined;
        }
        if (bounded && this.waiters.length - this.reacquiring >= this.maxQueued) {
            throw new Error('ConcurrencyLimiter queue full');
        }
        // Park until a finishing task HANDS us its slot (or close() rejects us). We must not increment
        // on wake: the count was never released (it was transferred), so re-incrementing would
        // over-admit when a fresh run() raced into the microtask gap and already took a (wrongly-freed)
        // slot.
        return new Promise((resolve, reject) => this.waiters.push(error => (error ? reject(error) : resolve())));
    }
    release() {
        const next = this.waiters.shift();
        if (next) {
            next(); // transfer this slot to the next waiter — active count stays the same (no free window)
        }
        else {
            this.active--; // no one waiting: actually release the slot
        }
    }
}
exports.ConcurrencyLimiter = ConcurrencyLimiter;
