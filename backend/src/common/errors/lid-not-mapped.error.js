"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LidNotMappedError = void 0;
/**
 * Thrown by an engine's `resolveContactPhone` when it cannot map a lid to a phone right now: no
 * cache, table or key store knows the pair. It is not a "no phone" answer, and unlike a transient
 * engine failure it will not clear on the next attempt, so callers may hold off before asking again.
 */
class LidNotMappedError extends Error {
    constructor(lid) {
        super(`lid ${lid} is not mapped in this session`);
        this.name = 'LidNotMappedError';
    }
}
exports.LidNotMappedError = LidNotMappedError;
