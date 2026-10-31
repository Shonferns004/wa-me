/**
 * Payload builders for the chat composer's send path.
 *
 * These live here rather than inline in `ChatComposer` because the composer treated "has an
 * attachment" and "is replying" as mutually exclusive, and the resulting bug — replying with an
 * attachment silently dropped the quote — had no assertion anywhere. As pure payload builders they
 * are cheaper to test here than through a rendered composer, which is the shape most of this
 * project's suites already take.
 */
/**
 * The id to quote. Only a message that carries a WhatsApp id can be quoted: a local temp_/sent_ id is
 * one the gateway can never resolve, so the thread hides Reply on a bubble that has no WA id yet.
 */
export function quotedIdOf(replyingTo) {
    return replyingTo?.waMessageId || undefined;
}
/**
 * Body text for the quoted-message preview. A non-text message has no meaningful body to show, so
 * its type stands in, worded by `typeLabel` so it matches the composer's own reply banner.
 */
function quotedPreviewBody(replyingTo, typeLabel) {
    return replyingTo.type && replyingTo.type !== 'text' ? typeLabel(replyingTo.type) : (replyingTo.body ?? '');
}
/**
 * Body for a media send. The quote key is omitted entirely rather than set to `undefined` when the
 * composer is not replying: the API rejects unknown/empty fields, and an always-present key would
 * also make every ordinary media send look like a failed reply in a request log.
 */
export function buildMediaSendPayload(attachment, caption, replyingTo) {
    const quotedMessageId = quotedIdOf(replyingTo);
    return {
        base64: attachment.base64,
        mimetype: attachment.mimetype,
        filename: attachment.filename,
        caption,
        ...(quotedMessageId ? { quotedMessageId } : {}),
    };
}
/**
 * Metadata for the optimistic bubble. Media and quote are independent: an attachment sent as a
 * reply has both, which is precisely the combination the previous either/or could not express.
 */
export function buildOptimisticMetadata(attachment, replyingTo, typeLabel) {
    if (!attachment && !replyingTo)
        return undefined;
    return {
        ...(attachment
            ? { media: { mimetype: attachment.mimetype, filename: attachment.filename, data: attachment.base64 } }
            : {}),
        ...(replyingTo
            ? { quotedMessage: { id: quotedIdOf(replyingTo), body: quotedPreviewBody(replyingTo, typeLabel) } }
            : {}),
    };
}
