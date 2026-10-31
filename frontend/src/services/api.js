// API Service Layer for OpenWA Dashboard
// Centralized API client with TypeScript types
import { warnIfInsecureHttpUrl } from '../utils/urlSecurity';
import { isKeyUnusable } from '../utils/authLifecycle';
import { fetchAllPages } from '../utils/fetchAllPages';
// Resolve the API base URL. By default this is the same-origin relative path '/api',
// correct when the dashboard and API are served from the same origin (the default
// single-container setup). For a split-origin deployment (dashboard hosted separately
// from the API), set VITE_API_URL at build time to the API ORIGIN — e.g.
// `VITE_API_URL=https://gateway.example.com` — and the '/api' prefix is appended here.
// Previously VITE_API_URL was documented but never read, so the dashboard always called
// same-origin '/api' and a split deployment failed with "Invalid API Key" (#91).
// Exported so direct fetches (e.g. auth/validate in Login.jsx / App.jsx) honor VITE_API_URL
// too — otherwise split-origin deployments break. Empty VITE_API_URL → '/api'.
export const API_ORIGIN = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
export const API_BASE_URL = `${API_ORIGIN}/api`;
// Warn (not refuse — would break dev + TLS-terminating-proxy) when the API origin is an
// insecure http:// URL pointing at a non-localhost host (API keys sent in cleartext).
if (API_ORIGIN)
    warnIfInsecureHttpUrl(API_ORIGIN, 'VITE_API_URL');
// Mirrors CHAT_KINDS in the backend webhook filter registry (src/modules/webhook/filters/filter-types.ts).
export const CHAT_KINDS = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];
// Engine-neutral message types (mirrors the backend's IWhatsAppEngine MessageType). The backend
// normalizes raw engine tokens at the adapter boundary (#265/#270), so persisted rows, the
// message.received/sent payloads, and the websocket all use these values.
export const MESSAGE_TYPES = [
    'text',
    'image',
    'video',
    'audio',
    'voice',
    'document',
    'sticker',
    'location',
    'contact',
    'poll',
    'call',
    'revoked',
    'order',
    'product',
    'masked',
    'unknown',
];
/** Coerce an arbitrary string (e.g. a raw websocket payload field) to a known MessageType. */
export function asMessageType(value) {
    return MESSAGE_TYPES.includes(value ?? '') ? value : 'unknown';
}
// =============================================================================
// API Client
// =============================================================================
// Shared failure handling for every response shape (json/text/blob). When the stored API key is
// unusable (a 401 for an invalid/expired/revoked key, or a 403 because its allowedIps refuse this
// client) clear it and return to login so the user isn't stuck on a dashboard where every request
// fails; the never-settling promise halts this request's chain so callers neither flash a generic
// error toast nor receive an undefined payload while the page navigates away. Otherwise throw an
// Error carrying the HTTP status and, when the gateway supplied one, its machine code.
// `sentKey` is the key the request carried (null when none). Logout aborts nothing in flight, so an
// answer can arrive after the stored key changed. With a key sent but none stored, a sign-out is
// already under way (an earlier failure of the same burst, or the user on the login form): stay
// silent and do not navigate again. A request sent without a key comes only from a chain that
// outlived a logout (the dashboard shows the login form whenever no key is stored), so with none
// stored it stays silent too rather than reloading the login form under the user. With another key
// stored, the answer speaks for a key no longer in use and must not sign out the current one, so it
// fails like any other error.
async function handleErrorResponse(response, sentKey) {
    // On a non-JSON body (e.g. a reverse-proxy 502/503/504 HTML page) fall through to `HTTP <status>`
    // rather than statusText: the toast folds an exact `HTTP 502`/`HTTP 503` into its connection-lost
    // toast (a 504 keeps its own), and statusText is empty over HTTP/2 anyway.
    const error = await response.json().catch(() => ({}));
    const storedKey = sessionStorage.getItem('openwa_api_key');
    if (isKeyUnusable(response.status, error.message) && (storedKey === sentKey || storedKey === null)) {
        sessionStorage.removeItem('openwa_api_key');
        if (typeof window !== 'undefined') {
            if (sentKey !== null && storedKey === sentKey)
                window.location.assign('/');
            return new Promise(() => { });
        }
    }
    // Carry the HTTP status on the Error (message unchanged, so the toast de-dup still matches) so
    // callers can tell apart a permission 403 from a real server 5xx instead of guessing from text.
    // Carry the machine `code` too: the gateway's stable codes (SESSION_LOGOUT_INCOMPLETE,
    // SESSION_NAME_TEARDOWN_PENDING, …) drive specific recovery UI, and a reverse-proxy 502 that
    // never reached the gateway carries no code at all — that distinction is exactly what the unlink
    // classifier keys on instead of fragile message heuristics.
    const err = new Error(error.message || `HTTP ${response.status}`);
    err.status = response.status;
    if (typeof error.code === 'string')
        err.code = error.code;
    // Retry-After in seconds (an HTTP date is ignored): the media loaders wait at least that long before retrying a 503.
    const retryAfter = Number(response.headers.get('Retry-After') ?? Number.NaN);
    if (retryAfter >= 0)
        err.retryAfterSeconds = retryAfter;
    throw err;
}
async function request(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    // Get API key from sessionStorage for authentication
    const apiKey = sessionStorage.getItem('openwa_api_key');
    // For FormData (file uploads) let the browser set multipart/form-data + boundary itself.
    const isFormData = options.body instanceof FormData;
    const headers = {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        ...options.headers,
    };
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        return handleErrorResponse(response, apiKey);
    }
    if (response.status === 204) {
        return undefined;
    }
    return response.json();
}
/** Like {@link request} but returns the raw response text — e.g. a plugin's HTML config-UI bundle. */
async function requestText(endpoint) {
    const apiKey = sessionStorage.getItem('openwa_api_key');
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        headers: { ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
    });
    if (!response.ok) {
        return handleErrorResponse(response, apiKey);
    }
    return response.text();
}
/** Like {@link request} but returns a Blob — e.g. for status media downloads. */
async function requestBlob(endpoint, signal) {
    const url = `${API_BASE_URL}${endpoint}`;
    // Get API key from sessionStorage for authentication
    const apiKey = sessionStorage.getItem('openwa_api_key');
    const headers = {
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    };
    const response = await fetch(url, { headers, signal });
    if (!response.ok) {
        return handleErrorResponse(response, apiKey);
    }
    return response.blob();
}
// =============================================================================
// Session API
// =============================================================================
export const sessionApi = {
    list: () => request('/sessions'),
    get: (id) => request(`/sessions/${id}`),
    create: (name, options) => request('/sessions', {
        method: 'POST',
        body: JSON.stringify({
            name,
            ...(options?.proxyUrl ? { proxyUrl: options.proxyUrl } : {}),
        }),
    }),
    delete: (id) => request(`/sessions/${id}`, { method: 'DELETE' }),
    getConfig: (id) => request(`/sessions/${id}/config`),
    // PATCH merges: only the keys sent are touched. Send null to clear one back to its default.
    updateConfig: (id, patch) => request(`/sessions/${id}/config`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    }),
    getProxy: (id) => request(`/sessions/${id}/proxy`),
    updateProxy: (id, patch) => request(`/sessions/${id}/proxy`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    }),
    start: (id) => request(`/sessions/${id}/start`, { method: 'POST' }),
    stop: (id) => request(`/sessions/${id}/stop`, { method: 'POST' }),
    logout: (id) => request(`/sessions/${id}/logout`, { method: 'POST' }),
    forceKill: (id) => request(`/sessions/${id}/force-kill`, { method: 'POST' }),
    getQR: (id) => request(`/sessions/${id}/qr`),
    requestPairingCode: (id, phoneNumber) => request(`/sessions/${id}/pairing-code`, {
        method: 'POST',
        body: JSON.stringify({ phoneNumber }),
    }),
    getStats: () => request('/sessions/stats/overview'),
    getGroups: (id) => request(`/sessions/${id}/groups`),
    // Operator route, Baileys only: whatsapp-web.js answers 501. Participants are WhatsApp ids (`…@c.us`).
    createGroup: (id, name, participants) => request(`/sessions/${id}/groups`, {
        method: 'POST',
        body: JSON.stringify({ name, participants }),
    }),
    getGroup: (id, groupId) => request(`/sessions/${id}/groups/${encodeURIComponent(groupId)}`),
    // The group writes below are operator routes. Whether WhatsApp lets this account make them (an admin,
    // or any member while the group's info is unlocked) is decided by WhatsApp; a refusal answers 403.
    setGroupSubject: (id, groupId, subject) => request(`/sessions/${id}/groups/${encodeURIComponent(groupId)}/subject`, {
        method: 'PUT',
        body: JSON.stringify({ subject }),
    }),
    setGroupDescription: (id, groupId, description) => request(`/sessions/${id}/groups/${encodeURIComponent(groupId)}/description`, {
        method: 'PUT',
        body: JSON.stringify({ description }),
    }),
    setGroupPicture: (id, groupId, base64, mimetype) => request(`/sessions/${id}/groups/${encodeURIComponent(groupId)}/picture`, {
        method: 'PUT',
        body: JSON.stringify({ base64, mimetype }),
    }),
    addGroupParticipants: (id, groupId, participants) => request(`/sessions/${id}/groups/${encodeURIComponent(groupId)}/participants`, {
        method: 'POST',
        body: JSON.stringify({ participants }),
    }),
    removeGroupParticipants: (id, groupId, participants) => request(`/sessions/${id}/groups/${encodeURIComponent(groupId)}/participants`, {
        method: 'DELETE',
        body: JSON.stringify({ participants }),
    }),
    setGroupAdmins: (id, groupId, participants, admin) => request(`/sessions/${id}/groups/${encodeURIComponent(groupId)}/participants/${admin ? 'promote' : 'demote'}`, { method: 'POST', body: JSON.stringify({ participants }) }),
    leaveGroup: (id, groupId) => request(`/sessions/${id}/groups/${encodeURIComponent(groupId)}/leave`, { method: 'POST' }),
    getChats: async (id, signal) => {
        let lastError;
        const { items, throttled } = await fetchAllPages(async (limit, offset) => {
            signal?.throwIfAborted();
            try {
                const data = await request(`/sessions/${id}/chats?limit=${limit}&offset=${offset}`, { signal });
                return { data, total: data.length < limit ? offset + data.length : Infinity };
            }
            catch (err) {
                lastError = err;
                throw err;
            }
            finally {
                signal?.throwIfAborted();
            }
        }, { pageSize: 1000, maxItems: Infinity });
        // A later throttled page must fail the load rather than present an incomplete sidebar.
        if (throttled)
            throw lastError;
        const seen = new Set();
        return items.filter(chat => {
            if (seen.has(chat.id))
                return false;
            seen.add(chat.id);
            return true;
        });
    },
    // `messageIds` are the messages to acknowledge. Baileys acknowledges them one by one and, without any, only the
    // newest it holds; whatsapp-web.js reads the whole chat and ignores them.
    markChatRead: (id, chatId, messageIds) => request(`/sessions/${id}/chats/read`, {
        method: 'POST',
        body: JSON.stringify({ chatId, ...(messageIds?.length ? { messageIds } : {}) }),
    }),
    // Both also delete the gateway's stored copy of the chat's messages (rows, media, search entries).
    clearChatMessages: (id, chatId) => request(`/sessions/${id}/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'DELETE',
    }),
    deleteChat: (id, chatId) => request(`/sessions/${id}/chats/delete`, {
        method: 'POST',
        body: JSON.stringify({ chatId }),
    }),
    // Archive and pin answer `{ success: false }` when the engine declined to act (WhatsApp keeps at most three
    // chats pinned), which the callers treat as a failure. Mute has no declined outcome and always answers success.
    archiveChat: (id, chatId, archive) => request(`/sessions/${id}/chats/archive`, {
        method: 'POST',
        body: JSON.stringify({ chatId, archive }),
    }),
    pinChat: (id, chatId, pin) => request(`/sessions/${id}/chats/pin`, {
        method: 'POST',
        body: JSON.stringify({ chatId, pin }),
    }),
    /** `muteUntil` is epoch MILLISECONDS; null unmutes. */
    muteChat: (id, chatId, muteUntil) => request(`/sessions/${id}/chats/mute`, {
        method: 'POST',
        body: JSON.stringify({ chatId, muteUntil }),
    }),
    markChatUnread: (id, chatId) => request(`/sessions/${id}/chats/unread`, {
        method: 'POST',
        body: JSON.stringify({ chatId }),
    }),
    // `offset` counts DB rows already fetched for this chat, never rendered rows: the thread merges
    // these with engine history, so paging by the merged length would skip DB rows. `total` is not
    // read to decide whether an older page exists — a page short of `limit` is; a chat with live
    // traffic keeps growing `total` after the fact, so comparing rows-held against it stops early.
    getChatMessages: (id, chatId, limit = 100, offset = 0) => request(`/sessions/${id}/messages?chatId=${encodeURIComponent(chatId)}&limit=${limit}&offset=${offset}`),
    // Live history straight from WhatsApp (bypasses the DB) — backfills a thread the gateway never
    // captured, e.g. a freshly paired session whose persisted store is still empty.
    // includeMedia downloads the media payload (base64) for history messages so stickers/images/
    // video/voice render instead of collapsing to an empty timestamp-only bubble.
    getChatHistory: (id, chatId, limit = 100, includeMedia = false) => request(`/sessions/${id}/messages/${encodeURIComponent(chatId)}/history?limit=${limit}${includeMedia ? '&includeMedia=true' : ''}`),
    // A message's stored media, fetched on demand. The message list carries its media inline only up to
    // MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES; past that budget the payload arrives as the
    // `{ omitted: true, sizeBytes }` marker and the bytes are only reachable here. Served as an
    // attachment (Content-Disposition), so callers download it rather than rendering it inline.
    getMessageMediaBlob: (id, chatId, messageId, signal) => requestBlob(`/sessions/${id}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`, signal),
    getSubscribedChannels: (id) => request(`/sessions/${id}/channels`),
    getChannelMessages: (id, channelId, limit = 50) => request(`/sessions/${id}/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`),
    getContactStatuses: (id) => request(`/sessions/${id}/status`),
    getStatusMediaBlob: (id, statusId, signal) => requestBlob(`/sessions/${id}/status/${encodeURIComponent(statusId)}/media`, signal),
    postTextStatus: (id, text, recipients, extra) => request(`/sessions/${id}/status/send-text`, {
        method: 'POST',
        body: JSON.stringify({ text, recipients, ...extra }),
    }),
    postImageStatus: (id, image, recipients, caption) => request(`/sessions/${id}/status/send-image`, {
        method: 'POST',
        body: JSON.stringify({ image, recipients, caption }),
    }),
};
// =============================================================================
// Webhook API
// =============================================================================
export const webhookApi = {
    listBySession: (sessionId) => request(`/sessions/${sessionId}/webhooks`),
    listAll: () => request('/webhooks'),
    create: (sessionId, data) => request(`/sessions/${sessionId}/webhooks`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    update: (sessionId, id, data) => request(`/sessions/${sessionId}/webhooks/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    delete: (sessionId, id) => request(`/sessions/${sessionId}/webhooks/${id}`, { method: 'DELETE' }),
    test: (sessionId, id) => request(`/sessions/${sessionId}/webhooks/${id}/test`, {
        method: 'POST',
    }),
};
// =============================================================================
// Template API
// =============================================================================
export const templateApi = {
    list: (sessionId) => request(`/sessions/${sessionId}/templates`),
    create: (sessionId, data) => request(`/sessions/${sessionId}/templates`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    update: (sessionId, id, data) => request(`/sessions/${sessionId}/templates/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    delete: (sessionId, id) => request(`/sessions/${sessionId}/templates/${id}`, { method: 'DELETE' }),
};
export const contactApi = {
    // The route caps a response at 1000 contacts; walk the pages so an address book past that is complete.
    // No item cap: the status recipient picker needs every contact, and the server's short page ends the walk.
    list: async (sessionId) => {
        let lastError;
        const { items, throttled } = await fetchAllPages(async (limit, offset) => {
            try {
                const data = await request(`/sessions/${sessionId}/contacts?limit=${limit}&offset=${offset}`);
                // The route answers a bare array with no total: a short page is the last one.
                return { data, total: data.length < limit ? offset + data.length : Infinity };
            }
            catch (err) {
                lastError = err;
                throw err;
            }
        }, { pageSize: 1000, maxItems: Infinity });
        // A page still throttled after the retries would leave the picker silently short; fail the whole
        // load with that page's 429, as a throttled first page already does.
        if (throttled)
            throw lastError;
        return items;
    },
    /** The ids of the contacts this account has blocked. */
    listBlocked: (sessionId) => request(`/sessions/${sessionId}/contacts/blocked`),
    block: (sessionId, contactId) => request(`/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/block`, {
        method: 'POST',
    }),
    unblock: (sessionId, contactId) => request(`/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/block`, {
        method: 'DELETE',
    }),
    /** Save the contact to the account's address book, or rename the entry it has. */
    upsert: (sessionId, contactId, firstName, lastName) => request(`/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}`, {
        method: 'PUT',
        body: JSON.stringify({ firstName, ...(lastName ? { lastName } : {}) }),
    }),
    checkNumber: (sessionId, number) => request(`/sessions/${sessionId}/contacts/check/${encodeURIComponent(number)}`),
    // Returns the contact/group profile picture URL. Both engines return null when the user hid their
    // picture or has none. The URL is a signed WhatsApp CDN link that expires in a few hours, so the
    // dashboard caches it for an hour (see useProfilePicture) and re-fetches on expiry.
    profilePicture: (sessionId, contactId) => request(`/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/profile-picture`),
    // Best-effort resolution of a contact id (e.g. an @lid privacy id) to its phone number (MSISDN
    // digits), or null when the engine can't map it. Cached a day by useResolvedPhone.
    resolvePhone: (sessionId, contactId) => request(`/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/phone`),
    // Batch-resolve profile picture URLs for a whole sidebar in ONE request — the per-chat burst of
    // parallel single fetches exhausts the per-IP throttle (429s). Engine lookups run 5 at a time
    // server-side; ids beyond the backend's 50-id cap are dropped client-side too.
    profilePictures: (sessionId, contactIds) => request(`/sessions/${sessionId}/contacts/profile-pictures?ids=${contactIds
        .slice(0, 50)
        .map(encodeURIComponent)
        .join(',')}`),
};
// =============================================================================
// API Key API
// =============================================================================
export const apiKeyApi = {
    list: () => request('/auth/api-keys'),
    create: (data) => request('/auth/api-keys', {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    update: (id, data) => request(`/auth/api-keys/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    delete: (id) => request(`/auth/api-keys/${id}`, { method: 'DELETE' }),
    revoke: (id) => request(`/auth/api-keys/${id}/revoke`, { method: 'POST' }),
};
// =============================================================================
// Audit/Logs API
// =============================================================================
export const auditApi = {
    list: (params) => {
        const query = new URLSearchParams();
        if (params?.action)
            query.set('action', params.action);
        if (params?.severity)
            query.set('severity', params.severity);
        if (params?.limit)
            query.set('limit', String(params.limit));
        if (params?.offset)
            query.set('offset', String(params.offset));
        const queryStr = query.toString();
        return request(`/audit${queryStr ? `?${queryStr}` : ''}`);
    },
};
// =============================================================================
// Message API
// =============================================================================
export const messageApi = {
    sendText: (sessionId, chatId, text) => request(`/sessions/${sessionId}/messages/send-text`, {
        method: 'POST',
        body: JSON.stringify({ chatId, text }),
    }),
    sendMedia: (sessionId, chatId, mediaType, payload) => request(`/sessions/${sessionId}/messages/send-${mediaType}`, {
        method: 'POST',
        body: JSON.stringify({ chatId, ...payload }),
    }),
    sendLocation: (sessionId, data) => request(`/sessions/${sessionId}/messages/send-location`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    sendContact: (sessionId, data) => request(`/sessions/${sessionId}/messages/send-contact`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // Stickers take the same media body as the other send-* endpoints (base64 XOR url + mimetype).
    sendSticker: (sessionId, chatId, payload) => request(`/sessions/${sessionId}/messages/send-sticker`, {
        method: 'POST',
        body: JSON.stringify({ chatId, ...payload }),
    }),
    sendPoll: (sessionId, data) => request(`/sessions/${sessionId}/messages/send-poll`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    forward: (sessionId, data) => request(`/sessions/${sessionId}/messages/forward`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // Async batch: returns 202 immediately; poll getBatchStatus until a terminal status.
    sendBulk: (sessionId, data) => request(`/sessions/${sessionId}/messages/send-bulk`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    getBatchStatus: (sessionId, batchId) => request(`/sessions/${sessionId}/messages/batch/${encodeURIComponent(batchId)}`),
    cancelBatch: (sessionId, batchId) => request(`/sessions/${sessionId}/messages/batch/${encodeURIComponent(batchId)}/cancel`, {
        method: 'POST',
    }),
    reply: (sessionId, data) => request(`/sessions/${sessionId}/messages/reply`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    /**
     * Tap a choice on an inbound business button/list prompt (Baileys only).
     * `messageId` is the prompt's WhatsApp id; `buttonId` is `buttons[].id`.
     */
    clickButton: (sessionId, data) => request(`/sessions/${sessionId}/messages/click-button`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    react: (sessionId, data) => request(`/sessions/${sessionId}/messages/react`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    delete: (sessionId, data) => request(`/sessions/${sessionId}/messages/delete`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
};
// =============================================================================
// Search API
// =============================================================================
export const searchApi = {
    search: (params) => {
        const query = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== '')
                query.set(key, String(value));
        });
        return request(`/search?${query.toString()}`);
    },
};
// =============================================================================
// Health & Infrastructure API
// =============================================================================
export const healthApi = {
    check: () => request('/health'),
};
export const infraApi = {
    getStatus: () => request('/infra/status'),
    getUpdateCheck: () => request('/infra/update-check'),
    getConfig: () => request('/infra/config'),
    saveConfig: (config) => request('/infra/config', {
        method: 'PUT',
        body: JSON.stringify(config),
    }),
    restart: (profiles, profilesToRemove, signal) => request('/infra/restart', {
        method: 'POST',
        body: JSON.stringify({ profiles: profiles || [], profilesToRemove: profilesToRemove || [] }),
        signal,
    }),
    // Readiness, not the plain /infra/health ping. The restart poll must not be able to latch onto the
    // process it just asked to shut down: /infra/health answers 200 for the whole drain,
    // while /health/ready reports 503 as soon as draining starts and stays 503 until both databases
    // answer. Public (no API key), like /infra/health.
    healthCheck: (signal) => request('/health/ready', { signal }),
    // Data migration: export all Data-DB tables (call while still on the OLD database, before switching),
    // then import after the switch + restart. Used by the DB-switch migration guard so data isn't lost.
    exportData: () => request('/infra/export-data'),
    // 200 contract includes the orphan-engine reconciliation result (restartRequired / notices /
    // stopped+failed ids). 409 has several causes and the error's `code` distinguishes them:
    // IMPORT_WOULD_ORPHAN_ENGINES (live engines exist for sessions the backup would remove; the
    // message lists them) is the only one the caller retries with stopOrphans=true to stop those
    // engines inside the request. IMPORT_ALREADY_RUNNING (another restore is in flight) and
    // IMPORT_NESTED_TRANSACTION (another transaction holds the connection) leave nothing to retry.
    // force is deliberately NOT exposed: it leaves the engines writing into the restored tables until
    // a restart — the window stopOrphans exists to close.
    importData: (tables, options) => request('/infra/import-data', {
        method: 'POST',
        body: JSON.stringify({ tables, ...options }),
    }),
};
// =============================================================================
// Plugins API
// =============================================================================
export const pluginsApi = {
    list: () => request('/plugins'),
    get: (id) => request(`/plugins/${id}`),
    enable: (id) => request(`/plugins/${id}/enable`, {
        method: 'POST',
    }),
    disable: (id) => request(`/plugins/${id}/disable`, {
        method: 'POST',
    }),
    updateConfig: (id, config) => request(`/plugins/${id}/config`, {
        method: 'PUT',
        body: JSON.stringify({ config }),
    }),
    /** Set which sessions a session-scoped plugin is activated for (['*'] = all). */
    setSessions: (id, sessions) => request(`/plugins/${id}/sessions`, { method: 'PUT', body: JSON.stringify({ sessions }) }),
    /** Set (or clear, with an empty object) a plugin's config override for one session. */
    updateSessionConfig: (id, sessionId, config) => request(`/plugins/${id}/config/${encodeURIComponent(sessionId)}`, {
        method: 'PUT',
        body: JSON.stringify({ config }),
    }),
    healthCheck: (id) => request(`/plugins/${id}/health`),
    install: (file) => {
        const form = new FormData();
        form.append('file', file);
        return request('/plugins/install', { method: 'POST', body: form });
    },
    installFromUrl: (url) => request('/plugins/install-url', { method: 'POST', body: JSON.stringify({ url }) }),
    updateFromUrl: (id, url) => request(`/plugins/${id}/update`, { method: 'POST', body: JSON.stringify({ url }) }),
    catalog: () => request('/plugins/catalog'),
    /** Fetch a plugin's sandboxed config-UI entry HTML (the API key stays here, in the parent). */
    getConfigUi: (id) => requestText(`/plugins/${id}/config-ui`),
    uninstall: (id) => request(`/plugins/${id}`, { method: 'DELETE' }),
    getEngines: () => request('/infra/engines'),
    getCurrentEngine: () => request('/infra/engines/current'),
};
export const pluginInstancesApi = {
    list: (pluginId) => request(`/integration/plugins/${pluginId}/instances`),
    create: (pluginId, body) => request(`/integration/plugins/${pluginId}/instances`, {
        method: 'POST',
        body: JSON.stringify(body),
    }),
    regenerateSecret: (pluginId, instanceId) => request(`/integration/plugins/${pluginId}/instances/${instanceId}/regenerate-secret`, {
        method: 'POST',
    }),
    update: (pluginId, instanceId, body) => request(`/integration/plugins/${pluginId}/instances/${instanceId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
    }),
    remove: (pluginId, instanceId) => request(`/integration/plugins/${pluginId}/instances/${instanceId}`, { method: 'DELETE' }),
};
export const statsApi = {
    getOverview: () => request('/stats/overview'),
    getMessages: (period) => request(`/stats/messages?period=${period}`),
};
