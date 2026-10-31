/**
 * Validation and filtering rules for the Sessions page.
 *
 * Each of these was re-derived inline at two or three places — the create button's disabled state,
 * the format hint under the input, and the duplicate-name warning each rebuilt the same name rule
 * with a different combination of its clauses. Stating a rule once and asking it what is wrong keeps
 * the three from drifting apart, and makes them testable.
 */
/** Names become on-disk directory names, so the format is deliberately narrow. */
const NAME_FORMAT = /^[a-z0-9-]+$/;
const NAME_MIN_LENGTH = 3;
const NAME_MAX_LENGTH = 50;
/**
 * Report EVERY issue rather than the first, because the form shows the format and length messages
 * independently — a name can be both malformed and too long, and the user should see both.
 *
 * `duplicate` is reported only once format and length pass: telling someone their unusable name is
 * also taken is noise, and it is how the form already behaved.
 */
export function sessionNameIssues(name, existingNames) {
    if (!name.trim())
        return ['empty'];
    const issues = [];
    if (!NAME_FORMAT.test(name))
        issues.push('format');
    if (name.length < NAME_MIN_LENGTH)
        issues.push('too-short');
    if (name.length > NAME_MAX_LENGTH)
        issues.push('too-long');
    if (issues.length === 0 && existingNames.includes(name))
        issues.push('duplicate');
    return issues;
}
/** The create button's gate: any issue at all blocks it. */
export function canCreateSession(name, existingNames) {
    return sessionNameIssues(name, existingNames).length === 0;
}
/** Pairing accepts a bare international number: digits only, no `+`, no separators. */
export function isValidPairingPhone(phone) {
    return /^[0-9]{6,15}$/.test(phone.trim());
}
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:']);
/** Matches the gateway's accepted per-session proxy URL schemes. */
export function isValidProxyUrl(url) {
    try {
        return PROXY_PROTOCOLS.has(new URL(url.trim()).protocol);
    }
    catch {
        return false;
    }
}
/**
 * The status filter's groups do not map one-to-one onto engine statuses — they are the operator's
 * mental model, not the engine's. `connecting` covers the three transient states, and `inactive`
 * covers everything that is neither ready nor moving, INCLUDING `action_required` and `failed`, which
 * both need the operator rather than time.
 */
const STATUS_GROUPS = {
    active: ['ready'],
    connecting: ['initializing', 'authenticating', 'qr_ready'],
    inactive: ['created', 'disconnected', 'action_required', 'failed'],
};
/**
 * Every session status the gateway can publish, flattened from the groups above. A runtime list
 * rather than a type union: the status pills and their CSS have to cover all of them, and a test can
 * only hold that against a value that exists at runtime.
 */
export const SESSION_STATUSES = Object.values(STATUS_GROUPS).flat();
export function matchesStatusFilter(status, filter) {
    if (filter === 'all')
        return true;
    return (STATUS_GROUPS[filter] ?? []).includes(status);
}
export function filterSessions(sessions, search, statusFilter) {
    const needle = search.toLowerCase();
    return sessions.filter(s => (s.name.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle)) &&
        matchesStatusFilter(s.status, statusFilter));
}
