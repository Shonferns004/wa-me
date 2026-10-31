"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decryptSecretPayload = decryptSecretPayload;
exports.bytesOf = bytesOf;
exports.messageSecretOf = messageSecretOf;
exports.withoutDevice = withoutDevice;
exports.senderForms = senderForms;
const node_crypto_1 = require("node:crypto");
const LABELS = { edit: 'Message Edit', reaction: 'Enc Reaction' };
const SECRET_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A message holds at most a text of about 64 KiB, and the largest sample payloads are a few KiB. */
const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Ids one party can be written as (phone and lid, with the account's own forms); a few at most. */
const MAX_FORMS = 4;
/**
 * The plaintext of an edit or reaction payload, or undefined when no pair of the candidate ids
 * authenticates it. Never throws: a payload that is not for this message, or has been altered, is
 * simply not readable.
 */
function decryptSecretPayload(input) {
    const { kind, secret, iv, payload, targetId } = input;
    if (!targetId || secret.length !== SECRET_BYTES || iv.length !== IV_BYTES)
        return undefined;
    if (payload.length <= TAG_BYTES || payload.length > MAX_PAYLOAD_BYTES)
        return undefined;
    const authors = [...new Set(input.targetAuthors)].slice(0, MAX_FORMS);
    const modifiers = [...new Set(input.modifiers)].slice(0, MAX_FORMS);
    const salt = Buffer.alloc(32);
    const tag = Buffer.from(payload.subarray(payload.length - TAG_BYTES));
    const body = Buffer.from(payload.subarray(0, payload.length - TAG_BYTES));
    for (const author of authors) {
        for (const modifier of modifiers) {
            const info = Buffer.from(`${targetId}${author}${modifier}${LABELS[kind]}`);
            try {
                const key = Buffer.from((0, node_crypto_1.hkdfSync)('sha256', secret, salt, info, 32));
                const decipher = (0, node_crypto_1.createDecipheriv)('aes-256-gcm', key, iv);
                decipher.setAuthTag(tag);
                return Buffer.concat([decipher.update(body), decipher.final()]);
            }
            catch {
                // Not this pair of ids: the authentication tag did not verify.
            }
        }
    }
    return undefined;
}
/**
 * Bytes of a proto field in either shape the adapter meets: a live message carries a `Uint8Array`,
 * and a message read back from the store carries its base64 text (or a `{ type: 'Buffer', data }`
 * pair from an older row).
 */
function bytesOf(value) {
    if (value instanceof Uint8Array)
        return Buffer.from(value);
    if (typeof value === 'string')
        return value ? Buffer.from(value, 'base64') : undefined;
    if (value && typeof value === 'object') {
        const { type, data } = value;
        if (type === 'Buffer') {
            if (Array.isArray(data))
                return Buffer.from(data);
            if (typeof data === 'string')
                return Buffer.from(data, 'base64');
        }
    }
    return undefined;
}
const WRAPPERS = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'editedMessage',
    'associatedChildMessage',
    'groupStatusMessage',
    'groupStatusMessageV2',
];
/** The secret a message carries, at the top level or inside the wrappers a disappearing chat adds. */
function messageSecretOf(message) {
    let current = message;
    for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
        const context = current.messageContextInfo;
        const secret = bytesOf(context?.messageSecret);
        if (secret)
            return secret;
        const wrapper = WRAPPERS.find(name => current?.[name]);
        current = wrapper ? current[wrapper].message : undefined;
    }
    return undefined;
}
/** `user@server` with any device suffix (`:12`) removed: the form a message secret is keyed by. */
function withoutDevice(jid) {
    return jid.replace(/:\d+(?=@)/, '');
}
/**
 * The forms a message's sender may be written as in its key: the account's own ids for a message it
 * sent, else the group participant (and its phone or lid twin), else the 1:1 chat and its twin.
 */
function senderForms(key, own) {
    const forms = key.fromMe === true
        ? [...own]
        : key.participant
            ? [key.participant, key.participantAlt]
            : [key.remoteJid, key.remoteJidAlt];
    const named = forms.filter((jid) => !!jid && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast'));
    return [...new Set(named.map(withoutDevice))].slice(0, MAX_FORMS);
}
