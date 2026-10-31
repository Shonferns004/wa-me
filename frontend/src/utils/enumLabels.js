/**
 * The key naming a message type where the type is a category: a chart slice, a webhook filter
 * value. `unknown` there is an unclassified type, so it cannot use chats.messageType.unknown, the
 * reply banner's generic "Message", which would read as "any message".
 */
export const messageTypeLabelKey = (type) => type === 'unknown' ? 'chats.messageType.unknownType' : `chats.messageType.${type}`;
/**
 * A webhook filter value in words, for the enum fields (message type, chat kind). Any other field,
 * or a value with no label, reads as the raw value the filter sends.
 */
export function filterValueLabel(t, field, value) {
    const key = field === 'type' ? messageTypeLabelKey(value) : field === 'kind' ? `chats.kind.${value}` : undefined;
    return key ? t(key, { defaultValue: value }) : value;
}
