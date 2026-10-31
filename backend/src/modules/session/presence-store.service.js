"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresenceStore = void 0;
const common_1 = require("@nestjs/common");
/**
 * Bound on how many chats one session keeps presence for. Presence is only reported for chats that
 * were explicitly subscribed, so this is already caller-bounded; the cap exists so a client that
 * subscribes in a loop cannot grow the map without limit. Eviction is oldest-observed-first.
 */
const MAX_CHATS_PER_SESSION = 500;
/**
 * The last presence WhatsApp reported for each subscribed chat.
 *
 * In memory because presence IS ephemeral — "typing, three seconds ago" has no meaning after a
 * restart, and persisting it would serve confident answers about a state that expired long before.
 * It is also the only thing that can answer a read at all: presence cannot be queried from either
 * library, only received after a subscription, so a `GET` has nothing to fetch and everything to
 * remember.
 */
let PresenceStore = class PresenceStore {
    bySession = new Map();
    /**
     * Last successful `PUT /presence` preference per session (`true` = stay online, `false` = stay
     * offline). Re-applied once each time that engine's connection opens — Baileys broadcasts
     * `available` on connect, which would otherwise wipe it. Cleared with the rest of the session's
     * presence when the engine is replaced or the session is deleted. Not written when the publish
     * itself failed.
     */
    ownIntent = new Map();
    /** Remember the account's own global presence preference for this connection. */
    setOwnIntent(sessionId, available) {
        this.ownIntent.set(sessionId, available);
    }
    /** The last setOwnIntent value, or undefined when the caller never set one. */
    getOwnIntent(sessionId) {
        return this.ownIntent.get(sessionId);
    }
    /**
     * Record a report. Returns whether it CHANGED anything a consumer would care about — WhatsApp
     * re-sends the same state freely, and dispatching a webhook per repeat would make presence the
     * loudest event in the system by a wide margin for no added information.
     *
     * `lastSeen` and `groupOnlineCount` drifting on their own do not count as a change: they move
     * continuously while nothing observable happens, and treating them as news would defeat the
     * suppression entirely.
     */
    record(sessionId, event, at = Date.now()) {
        const chats = this.bySession.get(sessionId) ?? new Map();
        this.bySession.set(sessionId, chats);
        const previous = chats.get(event.chatId);
        const next = {
            chatId: event.chatId,
            participants: event.participants,
            ...(event.groupOnlineCount === undefined ? {} : { groupOnlineCount: event.groupOnlineCount }),
            observedAt: at,
        };
        // Re-insert so the map stays ordered by recency and the eviction below drops the stalest chat.
        chats.delete(event.chatId);
        chats.set(event.chatId, next);
        while (chats.size > MAX_CHATS_PER_SESSION) {
            const oldest = chats.keys().next().value;
            if (oldest === undefined)
                break;
            chats.delete(oldest);
        }
        return !samePresence(previous?.participants, event.participants);
    }
    /** The last known presence for a chat, or null if none was ever reported. */
    get(sessionId, chatId) {
        return this.bySession.get(sessionId)?.get(chatId) ?? null;
    }
    /** Drop everything for a session — it stopped, was deleted, or its engine was replaced. */
    clear(sessionId) {
        this.bySession.delete(sessionId);
        this.ownIntent.delete(sessionId);
    }
};
exports.PresenceStore = PresenceStore;
exports.PresenceStore = PresenceStore = __decorate([
    (0, common_1.Injectable)()
], PresenceStore);
/**
 * Whether two participant lists say the same thing. Order is not significant — the engines build the
 * list by iterating an object, so a reordering is not a presence change and must not read as one.
 */
function samePresence(before, after) {
    if (!before || before.length !== after.length)
        return false;
    const previous = new Map(before.map(participant => [participant.id, participant.state]));
    return after.every(participant => previous.get(participant.id) === participant.state);
}
