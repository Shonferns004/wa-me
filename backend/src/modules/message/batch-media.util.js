"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripBatchMediaPayloads = stripBatchMediaPayloads;
exports.failUnfinishedSessionBatches = failUnfinishedSessionBatches;
const typeorm_1 = require("typeorm");
const template_render_1 = require("../../common/utils/template-render");
const message_batch_entity_1 = require("./entities/message-batch.entity");
/**
 * Drop base64 payloads from a finished batch's stored message list. A completed/cancelled batch is
 * terminal (never resumed), so the (often multi-MB) base64 in `message_batches.messages` is dead
 * weight; the descriptive fields (mimetype/filename/caption/url) are kept. An item that takes its
 * media from a variable (`base64: '{{pic}}'`) keeps the bytes in `variables`, so those go too.
 */
function stripBatchMediaPayloads(messages) {
    for (const m of messages ?? []) {
        for (const key of ['image', 'video', 'audio', 'document']) {
            const media = m.content[key];
            if (media && typeof media === 'object' && 'base64' in media) {
                if (typeof media.base64 === 'string' && m.variables && typeof m.variables === 'object') {
                    for (const name of (0, template_render_1.templateVariableNames)(media.base64))
                        delete m.variables[name];
                }
                delete media.base64;
            }
        }
    }
}
/**
 * Fail a session's unfinished (PENDING or PROCESSING) batches, with their media payloads stripped as on every
 * terminal path. For a session whose write scopes an operation closed and then did not remove: a run that
 * captured a scope before the close stops at its next item without recording anything, and nothing else moves
 * its row on while this process lives. The boot reaper gets any row this misses on the next start.
 */
async function failUnfinishedSessionBatches(dataSource, sessionId) {
    const batches = dataSource.getRepository(message_batch_entity_1.MessageBatch);
    const unfinished = await batches.find({
        where: { sessionId, status: (0, typeorm_1.In)([message_batch_entity_1.BatchStatus.PENDING, message_batch_entity_1.BatchStatus.PROCESSING]) },
    });
    for (const batch of unfinished) {
        stripBatchMediaPayloads(batch.messages);
        await batches.update({ id: batch.id, status: (0, typeorm_1.In)([message_batch_entity_1.BatchStatus.PENDING, message_batch_entity_1.BatchStatus.PROCESSING]) }, {
            status: message_batch_entity_1.BatchStatus.FAILED,
            completedAt: new Date(),
            messages: batch.messages,
        });
    }
}
