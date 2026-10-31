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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var SessionLidResolver_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionLidResolver = void 0;
const common_1 = require("@nestjs/common");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const wa_id_1 = require("../../engine/identity/wa-id");
const lid_not_mapped_error_1 = require("../../common/errors/lid-not-mapped.error");
/**
 * Resolves a privacy-id sender (`@lid`) to a phone number for inline attachment on incoming
 * messages (#263).
 *
 * Split out of SessionService because it is a self-contained read-through cache over the engine: it
 * invalidates session entries when their engine retires and cannot fail the message path. Its only
 * collaborators are the engine registry and the shared lid<->phone table. Keeping it here means the eviction policy and the
 * fire-and-forget persistence are testable without standing up the whole session lifecycle.
 */
let SessionLidResolver = class SessionLidResolver {
    static { SessionLidResolver_1 = this; }
    engines;
    lidMappingStore;
    /**
     * Bounded cache keyed `${sessionId}:${lid}`. Caches misses (null) too, for a while ({@link recheckAt}), so
     * a chatty unmapped sender isn't re-queried on every message (which also reduces engine rate-limit
     * pressure). Best-effort feature, so staleness is acceptable.
     */
    cache = new Map();
    static CACHE_MAX = 5000;
    /**
     * When an unmapped-lid lookup may be retried, per key, on {@link now}. A rejection is not cached above (it
     * is not an answer), but a sender whose lid no store maps rejects on every message, and each retry costs
     * the engine a table query and a key-store read. Kept in memory only and never persisted.
     */
    retryAfter = new Map();
    static RETRY_AFTER_MS = 60_000;
    /** Lookups under way, per key, so messages that arrive together from one sender share a single one. */
    inFlight = new Map();
    /**
     * When a cached answer is looked up again, per key, on {@link now}. A contact can change or hide its number,
     * and the lid table can refuse a negative while another linked session owns the phone. At most one lookup
     * and one write per key per interval.
     */
    recheckAt = new Map();
    static RECHECK_MS = 5 * 60_000;
    /** Monotonic clock in ms, so a wall clock set back does not stretch a wait (a seam for tests). */
    now = () => performance.now();
    constructor(engines, lidMappingStore) {
        this.engines = engines;
        this.lidMappingStore = lidMappingStore;
        engines.onRetire(id => {
            for (const map of [this.cache, this.retryAfter, this.inFlight, this.recheckAt]) {
                for (const key of map.keys())
                    if (key.startsWith(`${id}:`))
                        map.delete(key);
            }
        });
    }
    /**
     * Best-effort resolution, cached per session (incl. misses). Never throws — returns null on any
     * failure or when the engine isn't available. Gated by the caller on `RESOLVE_LID_TO_PHONE`.
     */
    async resolveSenderPhone(sessionId, contactId) {
        const key = `${sessionId}:${contactId}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            if ((this.recheckAt.get(key) ?? Infinity) > this.now())
                return cached;
            this.forget(key);
        }
        if ((this.retryAfter.get(key) ?? 0) > this.now()) {
            return null;
        }
        // Neither the cache nor the hold above is set until a lookup lands, so a burst of messages from a
        // new sender, as a reconnect delivers, would otherwise start one engine lookup per message.
        let lookup = this.inFlight.get(key);
        if (!lookup) {
            lookup = this.lookup(sessionId, contactId, key).finally(() => {
                if (this.inFlight.get(key) === lookup)
                    this.inFlight.delete(key);
            });
            this.inFlight.set(key, lookup);
        }
        return lookup;
    }
    /** One engine lookup for a sender, with its caching and persistence. */
    async lookup(sessionId, contactId, key) {
        let phone;
        const engine = this.engines.get(sessionId);
        let failure;
        // `resolved` marks a definitive engine answer: a rejection or a missing engine is a transient
        // unknown, NOT "this contact has no phone", and must never overwrite a stored mapping (#1058).
        // Engines reject rather than answer null when they cannot decide (a Baileys lid no cache, table
        // or key store maps), so only a real "no phone" reaches the null write below.
        let resolved = false;
        try {
            if (engine) {
                phone = (await engine.resolveContactPhone(contactId)) ?? null;
                resolved = true;
            }
            else {
                phone = null;
            }
        }
        catch (err) {
            phone = null;
            failure = err;
        }
        if (engine && !this.engines.isLive(sessionId, engine))
            return null;
        // Only an unmapped lid waits: any other rejection (a dead page, a rate limit) is retried on the
        // sender's next message, since the engine may answer as soon as it recovers.
        if (failure instanceof lid_not_mapped_error_1.LidNotMappedError) {
            this.retryAfter.delete(key); // re-inserted at the newest end, so the FIFO bound drops the oldest
            if (this.retryAfter.size >= SessionLidResolver_1.CACHE_MAX) {
                this.retryAfter.delete(this.retryAfter.keys().next().value);
            }
            this.retryAfter.set(key, this.now() + SessionLidResolver_1.RETRY_AFTER_MS);
        }
        // Only a definitive answer is cached: a transient null would otherwise stick for the process life.
        if (resolved) {
            this.retryAfter.delete(key);
            // Bounded FIFO eviction: Map preserves insertion order, so the first key is the oldest.
            if (this.cache.size >= SessionLidResolver_1.CACHE_MAX) {
                for (const oldest of this.cache.keys()) {
                    this.forget(oldest);
                    break;
                }
            }
            this.cache.set(key, phone);
            this.recheckAt.set(key, this.now() + SessionLidResolver_1.RECHECK_MS);
        }
        // Persist the resolution so the read-path can bridge this contact's `@lid` and `@c.us` rows even
        // when the operator never sent to them (#583 R3 Phase 2). A definitive null is persisted too, so
        // a phone that later becomes hidden overwrites its stale mapping instead of being served forever
        // (#1058). Reuses the resolution above — no extra network call — and is fire-and-forget so
        // dispatch never blocks/fails on it. The store keeps a phone another session stored, since that
        // account may still see the number.
        if (engine && (phone || resolved)) {
            this.persist(key, sessionId, contactId, phone, engine);
        }
        return phone;
    }
    /**
     * Report an answer to the lid table. One whose write failed is dropped from the cache, so the sender's
     * next message is looked up again and reports what the engine answers then: replaying this answer could
     * write it over a newer phone the table has learned since, and a negative that never lands would leave a
     * number the contact hid mapped until a restart (#1058).
     */
    persist(key, sessionId, contactId, phone, engine) {
        const stored = phone && engine.contactPhoneLookupPersistence === 'seed'
            ? this.lidMappingStore?.rememberIfUnknown((0, wa_id_1.userPart)(contactId), phone, sessionId)
            : this.lidMappingStore?.remember((0, wa_id_1.userPart)(contactId), phone, sessionId);
        void stored
            ?.then(stored => {
            if (stored === false && this.engines.isLive(sessionId, engine))
                this.forget(key);
        })
            .catch(() => { });
    }
    /** Drop a cached answer, and when it was due to be looked up again. */
    forget(key) {
        this.cache.delete(key);
        this.recheckAt.delete(key);
    }
};
exports.SessionLidResolver = SessionLidResolver;
exports.SessionLidResolver = SessionLidResolver = SessionLidResolver_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [engine_registry_service_1.EngineRegistry,
        lid_mapping_store_service_1.LidMappingStoreService])
], SessionLidResolver);
