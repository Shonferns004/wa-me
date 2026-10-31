"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.countMetaValues = countMetaValues;
exports.metaText = metaText;
const node_util_1 = require("node:util");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * Counts what JSON.stringify would write for a worker's log metadata, and stops once the count passes `limit`: one
 * for every value, one per character of a string, a String wrapper or a typed array element, and one per character
 * of a property name. What the logger writes where JSON.stringify would write {} is counted too: the name, message and
 * stack of an Error, and one per entry of a Map or a Set plus the entries themselves, as the arrays it writes for them.
 *
 * JSON.stringify cannot be stopped part way: it lists every key of an object or typed array before it calls a
 * replacer for the first one, and it writes a shared reference out again at every use. So the size of the text has
 * to be bounded before it runs. A shared reference is counted at every use, and so is a property name, which is
 * written at every use of its object.
 *
 * The count can be higher than the length of the text. A property that JSON.stringify skips (undefined, a function,
 * a symbol) is counted as if it were written, and so is the value under a credential key, which is written as the
 * marker. A metadata whose count passes `limit` is replaced by the size marker whatever its text would measure; for
 * data that is plain JSON without a credential key the count never exceeds the length of the text, so a count past
 * `limit` means a longer text.
 */
function countMetaValues(meta, limit) {
    let count = 0;
    const open = new Set();
    // An object is walked by its own enumerable keys, an array by its elements, a Map or a Set by the list of its entries.
    const frames = [];
    const visit = (value) => {
        count++;
        if (typeof value === 'string')
            count += value.length;
        if (typeof value !== 'object' || value === null)
            return;
        // A cycle: JSON.stringify refuses it, so there is nothing more to count.
        if (open.has(value))
            return;
        if (ArrayBuffer.isView(value)) {
            count += value.length ?? 0;
            return;
        }
        let list = Array.isArray(value) ? value : null;
        // Brand checks, like the String wrapper's below, so a value made in another realm counts too.
        if (node_util_1.types.isMap(value) || node_util_1.types.isSet(value)) {
            count += value.size;
            // Listed only once the number of its entries fits.
            if (count > limit)
                return;
            list = Array.from(value);
        }
        // A String wrapper is written as its text, and its own properties are its characters, one per index. Its brand
        // is checked rather than instanceof, so a wrapper made in another realm counts too.
        if (Object.prototype.toString.call(value) === '[object String]') {
            count += value.length;
            return;
        }
        open.add(value);
        const keys = list
            ? null
            : node_util_1.types.isNativeError(value)
                ? [...new Set(['name', 'message', 'stack', ...Object.keys(value)])]
                : Object.keys(value);
        frames.push({ node: value, keys, list, length: (keys ?? list ?? []).length, next: 0 });
    };
    visit(meta);
    while (frames.length > 0 && count <= limit) {
        const frame = frames[frames.length - 1];
        if (frame.next < frame.length) {
            const index = frame.next++;
            if (frame.keys) {
                count += frame.keys[index].length;
                visit(frame.node[frame.keys[index]]);
            }
            else {
                visit(frame.list[index]);
            }
        }
        else {
            open.delete(frame.node);
            frames.pop();
        }
    }
    return count;
}
/**
 * The JSON text the logger writes for a worker's log metadata: every object in the form the logger's copy writes it
 * (writtenForm), and the value of a credential key as the marker. Each object is rendered once, so one that holds
 * itself is a cycle JSON.stringify refuses like any other, and a BigInt, boxed or not, is refused wherever it is: its
 * text is never built on the host. Run only on a meta whose count fits the limit.
 */
function metaText(meta) {
    const rendered = new Map();
    return JSON.stringify(meta, function (key, value) {
        // Read from the holder: JSON.stringify has already put what a Date's toJSON returns (null for an invalid one) in
        // its place.
        const raw = this[key];
        if (!Array.isArray(this) && (0, logger_service_1.isSecretName)(key))
            return logger_service_1.REDACTED;
        if (typeof raw !== 'object' || raw === null)
            return value;
        if (!rendered.has(raw))
            rendered.set(raw, (0, logger_service_1.writtenForm)(raw));
        return rendered.get(raw);
    });
}
