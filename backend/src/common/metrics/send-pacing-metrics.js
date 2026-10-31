"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.incrementSendPacingRefusals = incrementSendPacingRefusals;
exports.getSendPacingRefusals = getSendPacingRefusals;
exports.resetSendPacingRefusals = resetSendPacingRefusals;
const refusals = new Map();
/** Record one refused send. */
function incrementSendPacingRefusals(reason) {
    refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
}
/**
 * Refusal totals by reason since process start. Reasons that have never fired are absent rather than
 * zero, matching the HTTP metrics' behaviour of emitting nothing until something is observed — a
 * series that appears at its first occurrence is easier to alert on than one pinned at zero.
 */
function getSendPacingRefusals() {
    return refusals;
}
/** Test-only: the counters are module-global and never reset in production. */
function resetSendPacingRefusals() {
    refusals.clear();
}
