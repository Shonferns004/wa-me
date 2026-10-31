"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readWid = readWid;
/**
 * Read a page-context Wid's serialized id under either property name, or undefined when neither is
 * present. Every raw-Wid read goes through this: the rename lands on all of them at once, and a
 * site that reads `_serialized` alone silently yields undefined — which `String()` then turns into
 * the literal id `"undefined"`, an id that looks real and addresses nothing.
 */
function readWid(wid) {
    if (typeof wid === 'string')
        return wid || undefined;
    return wid?._serialized ?? wid?.$1 ?? undefined;
}
