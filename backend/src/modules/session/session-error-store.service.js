"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionErrorStore = void 0;
const common_1 = require("@nestjs/common");
const session_entity_1 = require("./entities/session.entity");
/**
 * The transient reason a session last failed, or what the operator must do about it.
 *
 * It is deliberately in memory and not a column: it describes the CURRENT process's attempt, and a
 * restart that clears it is correct — a session whose reason was "Chromium failed to launch" should
 * not still say so after a successful restart.
 *
 * It lives here rather than in SessionService because it was the one piece of state that crossed a
 * boundary there: eight lifecycle paths write it, and exactly one reader — the session read model —
 * consumes it. Two concerns, one map.
 *
 * Every method is SYNCHRONOUS by contract. Two writers sit in synchronous void engine callbacks, and
 * one runs three statements before an `engines.delete(id)` whose ordering the surrounding comment
 * explicitly forbids reordering. An async setter here would silently reorder that.
 */
let SessionErrorStore = class SessionErrorStore {
    errors = new Map();
    /** Record why a session failed, or what it is waiting on. */
    set(sessionId, reason) {
        this.errors.set(sessionId, reason);
    }
    /** The recorded reason, if any. `attachTo` is the projection; this is the raw read. */
    get(sessionId) {
        return this.errors.get(sessionId);
    }
    /** Drop the reason — the session recovered, re-initialised, or was deleted. */
    clear(sessionId) {
        this.errors.delete(sessionId);
    }
    /**
     * Populate the transient `lastError` field. A FAILED session always carries its failure reason, an
     * ACTION_REQUIRED session carries what the operator must do (e.g. the whatsapp-web.js
     * onboarding-modal fallback, #982), and an INITIALIZING one carries the engine-internal reconnect
     * episode it is stuck in: that status is otherwise identical to a session that has never been
     * paired, and an engine that retries forever never reaches FAILED, so there is no later status at
     * which the reason would surface. It also carries a failed relaunch while a service-level reconnect
     * backs off before its next attempt, since that retry writes no status. INITIALIZING is safe to
     * include because the lifecycle clears this map immediately before every fresh engine start and
     * again on ready, so an ordinary startup has nothing to show. Any other status clears it, so a recovered session never shows a stale reason
     * even while the entry is still held.
     */
    attachTo(session) {
        session.lastError =
            session.status === session_entity_1.SessionStatus.FAILED ||
                session.status === session_entity_1.SessionStatus.ACTION_REQUIRED ||
                session.status === session_entity_1.SessionStatus.INITIALIZING
                ? this.errors.get(session.id)
                : undefined;
        return session;
    }
};
exports.SessionErrorStore = SessionErrorStore;
exports.SessionErrorStore = SessionErrorStore = __decorate([
    (0, common_1.Injectable)()
], SessionErrorStore);
