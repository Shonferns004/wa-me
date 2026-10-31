"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TABLE_IMPORTERS = void 0;
exports.deduplicateArchivedWebhookFailures = deduplicateArchivedWebhookFailures;
const nul_free_transformer_1 = require("../../common/transformers/nul-free.transformer");
const path_safety_1 = require("../../common/utils/path-safety");
const filter_validation_1 = require("../webhook/filters/filter-validation");
// Registers one concrete descriptor into the union-keyed TABLE_IMPORTERS array.
function defineTableImporter(importer) {
    return importer;
}
// A JSON column arrives decoded from Postgres and as text from SQLite. Text that does not parse is
// returned as-is, so a validator sees a string and refuses it rather than reading it as absent.
function decodeJsonColumn(value) {
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
// The entity columns that drop U+0000 do it in a TypeORM transformer, which raw SQL never runs. An
// older SQLite backup may still hold one, and PostgreSQL refuses it in a bound parameter, failing the
// whole restore. Apply the same drop here, to those same free-text columns and to the template and
// rule text the DTOs only refuse from 0.24.0 on; never to an id or a lookup key. A template name is the
// exception: no request can look up a name holding NUL, so keeping it would only strand the template.
function nulFree(value) {
    return nul_free_transformer_1.NulFreeTransformer.to(value);
}
/** Apply the terminal index's keeper order to archives created before that index existed. */
function deduplicateArchivedWebhookFailures(rows) {
    const owners = new Map();
    const identity = (row) => JSON.stringify([row.webhookId, row.idempotencyKey]);
    // SQLite's zone-less datetime strings represent UTC, just like PostgreSQL's explicit UTC exports.
    const timestamp = (value) => new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value).getTime();
    // Malformed archive rows must still reach the normal all-or-nothing restore checks.
    const eligible = (row) => row.attempts > 0 &&
        row.idempotencyKey != null &&
        [row.id, row.webhookId, row.sessionId, row.event, row.url, row.lastError, row.createdAt].every(value => value != null);
    for (const row of rows) {
        if (!eligible(row))
            continue;
        const key = identity(row);
        const previous = owners.get(key);
        if (!previous) {
            owners.set(key, row);
            continue;
        }
        const rank = Number(row.payload == null) - Number(previous.payload == null) ||
            previous.attempts - row.attempts ||
            timestamp(previous.createdAt) - timestamp(row.createdAt) ||
            (row.id === previous.id ? 0 : row.id > previous.id ? -1 : 1);
        if (rank < 0)
            owners.set(key, row);
    }
    return rows.filter(row => !eligible(row) || owners.get(identity(row)) === row);
}
// (sessionId, NUL-free name) -> id of the first archived template holding it, built once per table.
const templateNameOwners = new WeakMap();
function firstTemplateWithName(rows, sessionId, name) {
    let owners = templateNameOwners.get(rows);
    if (!owners) {
        owners = new Map();
        for (const row of rows) {
            const key = JSON.stringify([row.sessionId, nulFree(row.name)]);
            if (!owners.has(key))
                owners.set(key, row.id);
        }
        templateNameOwners.set(rows, owners);
    }
    return owners.get(JSON.stringify([sessionId, name]));
}
// Restore order is FK order: sessions first (webhooks/messages/templates/etc. reference it), the
// standalone cache/DLQ tables after. The per-block comments from the former inline import blocks
// live on their descriptor entries.
exports.TABLE_IMPORTERS = [
    // Import sessions first
    defineTableImporter({
        key: 'sessions',
        label: 'session',
        sql: `INSERT INTO sessions (id, name, status, phone, "pushName", config, "proxyUrl", "proxyType", "connectedAt", "lastActiveAt", "createdAt", "updatedAt", "desiredState")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        id: (session) => session.id,
        // Both columns reach an auth-directory path: the id keys the directory itself, and the name is
        // still weighed against it (the boot migration and the legacy purge on delete). An unvalidated
        // imported value (this path bypasses CreateSessionDto) could traverse the filesystem, and an
        // unsafe id would only surface later as a refused start. Skip + warn instead of throwing, so one
        // bad row doesn't 500 the whole restore.
        skip: (session) => {
            if (!(0, path_safety_1.isSafeSessionName)(session.id)) {
                return `Skipped session ${JSON.stringify(session.id)}: unsafe id`;
            }
            if ((0, path_safety_1.isSafeSessionName)(session.name))
                return null;
            return `Skipped session ${session.id}: unsafe name ${JSON.stringify(session.name)}`;
        },
        map: (session) => [
            session.id,
            session.name,
            session.status,
            session.phone,
            nulFree(session.pushName),
            typeof session.config === 'string' ? session.config : JSON.stringify(session.config || {}),
            session.proxyUrl,
            session.proxyType,
            session.connectedAt,
            session.lastActiveAt,
            session.createdAt,
            session.updatedAt,
            // A failed delete's 'deleting' restores as 'stopped': no delete runs for the restored row. A
            // backup written before the column existed, or an unknown value, restores as NULL: eligible for
            // auto-start and takeover, as before.
            session.desiredState === 'stopped' ||
                session.desiredState === 'deleting' ||
                session.desiredState === 'deleting-stopped'
                ? 'stopped'
                : null,
        ],
    }),
    // Import webhooks
    defineTableImporter({
        key: 'webhooks',
        label: 'webhook',
        sql: `INSERT INTO webhooks (id, "sessionId", url, events, secret, headers, filters, active, "retryCount", "lastTriggeredAt", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        id: (webhook) => webhook.id,
        // This path bypasses CreateWebhookDto. Dispatch reads a filters value without a conditions array
        // as "no filtering", so a malformed one stored verbatim would deliver every subscribed event, and
        // an events value that is not a list never fires at all. Veto the row with a warning, like the
        // sessions guard; any warning rolls the restore back and names the row.
        skip: (webhook) => {
            const events = decodeJsonColumn(webhook.events ?? []);
            if (!Array.isArray(events) || !events.every(event => typeof event === 'string')) {
                return `Skipped webhook ${webhook.id}: events is not a list of event names`;
            }
            const filterErrors = (0, filter_validation_1.collectFilterErrors)(decodeJsonColumn(webhook.filters));
            if (filterErrors.length === 0)
                return null;
            return `Skipped webhook ${webhook.id}: invalid filters (${filterErrors.join('; ')})`;
        },
        map: (webhook) => [
            webhook.id,
            webhook.sessionId,
            webhook.url,
            typeof webhook.events === 'string' ? webhook.events : JSON.stringify(webhook.events || []),
            // Rows exported after credential redaction (and hand-trimmed archives) carry no secret at
            // all — restore those as unsigned rather than failing the row on a missing key.
            webhook.secret ?? null,
            typeof webhook.headers === 'string' ? webhook.headers : JSON.stringify(webhook.headers || {}),
            webhook.filters == null
                ? null
                : typeof webhook.filters === 'string'
                    ? webhook.filters
                    : JSON.stringify(webhook.filters),
            webhook.active,
            webhook.retryCount,
            webhook.lastTriggeredAt,
            webhook.createdAt,
            webhook.updatedAt,
        ],
    }),
    // Import messages (optional)
    defineTableImporter({
        key: 'messages',
        label: 'message',
        sql: `INSERT INTO messages (id, "sessionId", "waMessageId", "chatId", "chatName", author, "from", "to", body, type, direction, "timestamp", metadata, status, "createdAt", "mediaPath", "mediaMimetype")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        id: (msg) => msg.id,
        map: (msg) => [
            msg.id,
            msg.sessionId,
            msg.waMessageId ?? null,
            msg.chatId,
            nulFree(msg.chatName ?? null),
            // Rows exported before the author column existed simply restore to NULL (legacy
            // behavior) instead of failing the whole import on an unknown key.
            msg.author ?? null,
            msg.from,
            msg.to,
            nulFree(msg.body ?? null),
            msg.type,
            msg.direction,
            msg.timestamp ?? null,
            msg.metadata == null ? null : typeof msg.metadata === 'string' ? msg.metadata : JSON.stringify(msg.metadata),
            msg.status,
            msg.createdAt,
            // Archives predating the chat-media columns restore to NULL, same as author above. Carrying
            // them matters because the media FILES ride along in the storage export: restoring the rows
            // without their pointers would turn every archived file into an orphan the sweep then reaps.
            msg.mediaPath ?? null,
            nulFree(msg.mediaMimetype ?? null),
        ],
    }),
    // Import message batches (optional)
    defineTableImporter({
        key: 'messageBatches',
        label: 'message batch',
        sql: `INSERT INTO message_batches (id, batch_id, session_id, status, messages, options, progress, results, current_index, created_at, updated_at, started_at, completed_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        id: (batch) => batch.id,
        map: (batch) => [
            batch.id,
            batch.batch_id,
            batch.session_id,
            batch.status,
            typeof batch.messages === 'string' ? batch.messages : JSON.stringify(batch.messages ?? []),
            batch.options == null ? null : typeof batch.options === 'string' ? batch.options : JSON.stringify(batch.options),
            batch.progress == null
                ? null
                : typeof batch.progress === 'string'
                    ? batch.progress
                    : JSON.stringify(batch.progress),
            batch.results == null ? null : typeof batch.results === 'string' ? batch.results : JSON.stringify(batch.results),
            batch.current_index,
            batch.created_at,
            batch.updated_at,
            batch.started_at,
            batch.completed_at,
        ],
    }),
    // Import templates (optional; FK -> sessions, restored above)
    defineTableImporter({
        key: 'templates',
        label: 'template',
        sql: `INSERT INTO templates (id, "sessionId", name, body, header, footer, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        id: (tpl) => tpl.id,
        // (sessionId, name) is unique, and the name loses its NUL characters below. Two names of one
        // session that differ only by NUL would collide on insert and roll the whole restore back, after
        // any orphan engines were stopped; refuse the second one here instead, naming both rows.
        skip: (tpl, rows = []) => {
            const name = nulFree(tpl.name);
            const owner = firstTemplateWithName(rows, tpl.sessionId, name);
            if (owner === undefined || owner === tpl.id)
                return null;
            return `Skipped template ${tpl.id}: name ${JSON.stringify(name)} without NUL characters collides with template ${owner} of session ${tpl.sessionId}`;
        },
        map: (tpl) => [
            tpl.id,
            tpl.sessionId,
            nulFree(tpl.name),
            nulFree(tpl.body),
            nulFree(tpl.header ?? null),
            nulFree(tpl.footer ?? null),
            tpl.createdAt,
            tpl.updatedAt,
        ],
    }),
    // Import baileys stored messages (optional; FK -> sessions, restored above)
    defineTableImporter({
        key: 'baileysStoredMessages',
        label: 'baileys stored message',
        sql: `INSERT INTO baileys_stored_messages (id, "sessionId", "waMessageId", "serializedMessage", "createdAt")
               VALUES ($1, $2, $3, $4, $5)`,
        id: (bsm) => bsm.id,
        map: (bsm) => [
            bsm.id,
            bsm.sessionId,
            bsm.waMessageId,
            bsm.serializedMessage,
            bsm.createdAt,
        ],
    }),
    // Import lid mappings (optional; not a FK, restored as a standalone cache table)
    defineTableImporter({
        key: 'lidMappings',
        label: 'lid mapping',
        sql: `INSERT INTO lid_mappings (lid, phone, "sessionId", "updatedAt", "isReported") VALUES ($1, $2, $3, $4, $5)`,
        id: (lm) => lm.lid,
        map: (lm) => [
            lm.lid,
            lm.phone ?? null,
            lm.sessionId ?? null,
            lm.updatedAt,
            lm.isReported === true || lm.isReported === 1,
        ],
    }),
    // Import chat states (optional; not a FK, restored as a standalone per-session cache table)
    defineTableImporter({
        key: 'chatStates',
        label: 'chat state',
        sql: `INSERT INTO chat_states ("sessionId", "chatId", "muteEndTime", archived, pinned, observed, "deletedAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        id: (cs) => `${cs.sessionId}/${cs.chatId}`,
        map: (cs) => [
            cs.sessionId,
            cs.chatId,
            cs.muteEndTime ?? null,
            cs.archived,
            cs.pinned,
            cs.observed ?? null,
            cs.deletedAt ?? null,
            cs.updatedAt,
        ],
    }),
    // Import plugin instances (Integration Fabric config + ingress HMAC secret)
    defineTableImporter({
        key: 'pluginInstances',
        label: 'plugin instance',
        sql: `INSERT INTO plugin_instances (id, "pluginId", "instanceId", "sessionScope", secret, "verifyToken", config, enabled, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        id: (pi) => pi.id,
        map: (pi) => [
            pi.id,
            pi.pluginId,
            pi.instanceId,
            pi.sessionScope,
            pi.secret,
            pi.verifyToken,
            pi.config == null ? null : typeof pi.config === 'string' ? pi.config : JSON.stringify(pi.config),
            pi.enabled,
            pi.createdAt,
            pi.updatedAt,
        ],
    }),
    // Import conversation mappings (handover state; sessionId is non-FK provenance)
    defineTableImporter({
        key: 'conversationMappings',
        label: 'conversation mapping',
        sql: `INSERT INTO conversation_mappings (id, "sessionId", "chatId", "pluginId", "instanceId", "providerConversationId", "handoverState", metadata, "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        id: (cm) => cm.id,
        map: (cm) => [
            cm.id,
            cm.sessionId,
            cm.chatId,
            cm.pluginId,
            cm.instanceId,
            cm.providerConversationId,
            cm.handoverState,
            cm.metadata == null ? null : typeof cm.metadata === 'string' ? cm.metadata : JSON.stringify(cm.metadata),
            cm.updatedAt,
        ],
    }),
    // Import ingress events (durable inbound dedup oracle; payload is JSON). The dispatch-lifecycle
    // columns ride along: dropping them would strand a restored 'pending' row (NULL dispatchState is
    // never swept by the reconciler) while its dedup key still blocks the provider's retry. Columns
    // absent from a pre-lifecycle backup import as NULL/0 — the same "not watched" reading legacy
    // rows have by design. dispatchAttempts is NOT NULL, so it coalesces to 0 rather than NULL.
    defineTableImporter({
        key: 'ingressEvents',
        label: 'ingress event',
        sql: `INSERT INTO ingress_events (id, "instanceId", "pluginId", "providerDeliveryId", route, payload, "payloadHash", "sessionId", "dispatchState", "dispatchAttempts", "lastDispatchAt", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        id: (ie) => ie.id,
        map: (ie) => [
            ie.id,
            ie.instanceId,
            ie.pluginId,
            ie.providerDeliveryId,
            ie.route,
            // A retired (NULL) payload must stay NULL — re-materializing it as '{}' would make a
            // slimmed dedup row read as a pending event with an empty body.
            ie.payload == null ? null : typeof ie.payload === 'string' ? ie.payload : JSON.stringify(ie.payload),
            ie.payloadHash ?? null,
            ie.sessionId,
            ie.dispatchState ?? null,
            ie.dispatchAttempts ?? 0,
            ie.lastDispatchAt ?? null,
            ie.createdAt,
        ],
    }),
    // Import webhook delivery failures (webhook DLQ)
    defineTableImporter({
        key: 'webhookDeliveryFailures',
        label: 'webhook delivery failure',
        sql: `INSERT INTO webhook_delivery_failures (id, "webhookId", "sessionId", event, url, "idempotencyKey", "deliveryId", attempts, "lastStatusCode", "lastError", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        id: (wf) => wf.id,
        map: (wf) => [
            wf.id,
            wf.webhookId,
            wf.sessionId,
            wf.event,
            wf.url,
            wf.idempotencyKey,
            wf.deliveryId,
            wf.attempts,
            wf.lastStatusCode,
            nulFree(wf.lastError),
            wf.createdAt,
        ],
    }),
    // Import the outbound delivery record. Restoring it restores the replay backlog: a 'pending'
    // row still carries its payload, so the reconciler on the target instance picks up where the
    // source left off.
    defineTableImporter({
        key: 'webhookOutboxEvents',
        label: 'webhook outbox event',
        sql: `INSERT INTO webhook_outbox_events (id, "webhookId", "sessionId", event, "idempotencyKey", "deliveryId", payload, state, attempts, "lastAttemptAt", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        id: (row) => row.id,
        map: (row) => [
            row.id,
            row.webhookId,
            row.sessionId,
            row.event,
            row.idempotencyKey,
            row.deliveryId,
            row.payload == null ? null : typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
            row.state,
            row.attempts,
            row.lastAttemptAt,
            row.createdAt,
        ],
    }),
    // Import integration delivery failures (inbound DLQ; direction restored as stored)
    defineTableImporter({
        key: 'integrationDeliveryFailures',
        label: 'integration delivery failure',
        sql: `INSERT INTO integration_delivery_failures (id, direction, "pluginId", "instanceId", "sessionId", "deliveryId", attempts, "lastError", payload, redriven, "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        id: (df) => df.id,
        map: (df) => [
            df.id,
            df.direction,
            df.pluginId,
            df.instanceId,
            df.sessionId,
            df.deliveryId,
            df.attempts,
            nulFree(df.lastError),
            df.payload == null ? null : typeof df.payload === 'string' ? df.payload : JSON.stringify(df.payload),
            df.redriven,
            df.createdAt,
        ],
    }),
    // Import status updates (24h-TTL status/story store; sessionId is non-FK provenance)
    defineTableImporter({
        key: 'statusUpdates',
        label: 'status update',
        sql: `INSERT INTO status_updates (id, "sessionId", "contactJid", "contactName", "contactPushName", "waStatusId", type, caption, "mediaPath", "mediaMimetype", "mediaOmitted", "omitReason", "backgroundColor", font, "postedAt", "expiresAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        id: (su) => su.id,
        map: (su) => [
            su.id,
            su.sessionId,
            su.contactJid,
            nulFree(su.contactName ?? null),
            nulFree(su.contactPushName ?? null),
            su.waStatusId,
            su.type,
            nulFree(su.caption ?? null),
            su.mediaPath ?? null,
            nulFree(su.mediaMimetype ?? null),
            su.mediaOmitted ?? false,
            su.omitReason ?? null,
            su.backgroundColor ?? null,
            su.font ?? null,
            su.postedAt,
            su.expiresAt,
        ],
    }),
    // Import automation rules (per-session autoreply rules; FK sessions ON DELETE CASCADE, so the
    // import's `DELETE FROM sessions` wipes them and they must be re-inserted or a restore
    // permanently loses every rule).
    defineTableImporter({
        key: 'automationRules',
        label: 'automation rule',
        sql: `INSERT INTO automation_rules (id, "sessionId", name, enabled, conditions, "replyText", "cooldownSeconds", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        id: (rule) => rule.id,
        // This path bypasses the rule DTOs. A conditions value without a conditions array matches every
        // inbound message, so a malformed one stored verbatim would autoreply to every contact; veto the
        // row with a warning, like the webhooks guard.
        skip: (rule) => {
            const errors = (0, filter_validation_1.collectFilterErrors)(decodeJsonColumn(rule.conditions));
            if (errors.length === 0)
                return null;
            return `Skipped automation rule ${rule.id}: invalid conditions (${errors.join('; ')})`;
        },
        map: (rule) => [
            rule.id,
            rule.sessionId,
            nulFree(rule.name),
            rule.enabled ?? true,
            rule.conditions == null
                ? null
                : typeof rule.conditions === 'string'
                    ? rule.conditions
                    : JSON.stringify(rule.conditions),
            nulFree(rule.replyText),
            rule.cooldownSeconds ?? 60,
            rule.createdAt,
            rule.updatedAt,
        ],
    }),
];
// The `as TableCounts` cast in importData means a dropped or mis-keyed descriptor is invisible to
// the compiler: the table would silently never import and would vanish from the restored-row total
// that guards against wiping a database with an empty payload. Assert the set at module load.
const EXPECTED_TABLE_KEYS = [
    'sessions',
    'webhooks',
    'messages',
    'messageBatches',
    'templates',
    'baileysStoredMessages',
    'lidMappings',
    'chatStates',
    'pluginInstances',
    'conversationMappings',
    'ingressEvents',
    'webhookDeliveryFailures',
    'webhookOutboxEvents',
    'integrationDeliveryFailures',
    'statusUpdates',
    'automationRules',
];
const importerKeys = exports.TABLE_IMPORTERS.map(importer => importer.key);
for (const key of EXPECTED_TABLE_KEYS) {
    if (!importerKeys.includes(key))
        throw new Error(`table-importers: missing descriptor for "${key}"`);
}
if (importerKeys.length !== EXPECTED_TABLE_KEYS.length) {
    throw new Error(`table-importers: expected ${EXPECTED_TABLE_KEYS.length} descriptors, found ${importerKeys.length}`);
}
