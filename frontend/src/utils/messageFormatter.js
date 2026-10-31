const FORMATS = {
    '*': 'bold',
    _: 'italic',
    '~': 'strike',
};
const BOUNDARY_CHAR = /^[\s.,;:!?()[\]{}'"<>]$/;
// Private-use-area delimiters resolveMentions wraps a resolved name in. Raw text is stripped of
// both before it gets here (chatMessages.js#stripMentionDelimiters), so a pair in the input is
// always one resolveMentions placed.
export const MENTION_OPEN = '';
export const MENTION_CLOSE = '';
/**
 * Parse a WhatsApp-formatted text string into a list of MessageNode.
 *
 * Algorithm:
 * 1. Extract code segments (triple-backtick blocks first, then single-backtick inline)
 *    by walking the string and emitting `codeblock` / `code` nodes for them; the
 *    remaining text segments are passed to the format parser.
 * 2. The format parser scans for the next opening marker (`*`, `_`, `~`) that has a valid
 *    boundary on the outside and a non-whitespace char immediately inside, finds the matching
 *    closing marker with the same boundary rules, and re-parses the inner content. Sibling
 *    segments are emitted iteratively and nesting is depth-capped (MAX_FORMAT_DEPTH), so a
 *    pathological message can't exhaust the call stack; beyond the cap the rest stays literal.
 * 3. Unbalanced or boundary-violating markers fall through as literal text.
 * 4. Each text leaf is split on the `MENTION_OPEN...MENTION_CLOSE` spans resolveMentions wraps a
 *    resolved name in (see chatMessages.js), emitting `mention` nodes. This runs at the leaf, after
 *    code and format parsing, so a mention inside *bold* keeps the bold; the format scanner steps
 *    over a span whole, so a `*` in a push name can neither open nor close a span.
 */
export function parseMessageBody(input) {
    if (input.length === 0)
        return [];
    // Step 1: peel off code segments, emit nodes between them.
    const nodes = [];
    let cursor = 0;
    const flushText = (end) => {
        if (end <= cursor)
            return;
        const slice = input.slice(cursor, end);
        // Loop instead of nodes.push(...parsed): spreading a huge segment list into push() hits the
        // engine's argument-count limit and throws the same RangeError as a stack overflow.
        for (const node of parseFormatting(slice))
            nodes.push(node);
        cursor = end;
    };
    // The next triple backtick is searched for again only once the cursor has passed it: looking from
    // the cursor on every turn scans the whole remainder each time when none follows.
    let tripleStart = input.indexOf('```');
    while (cursor < input.length) {
        // Look for next ``` first (longer marker wins).
        if (tripleStart !== -1 && tripleStart < cursor)
            tripleStart = input.indexOf('```', cursor);
        // A single backtick only wins when it comes before the triple, so the search stops there: running
        // on to the end of the body at every turn is quadratic in a message made of code blocks.
        const singleStart = findSingleBacktick(input, cursor, tripleStart === -1 ? input.length : tripleStart);
        let nextCode = null;
        let nextIdx = Infinity;
        if (tripleStart !== -1 && tripleStart < nextIdx) {
            nextCode = 'triple';
            nextIdx = tripleStart;
        }
        if (singleStart !== -1 && singleStart < nextIdx) {
            nextCode = 'single';
            nextIdx = singleStart;
        }
        if (!nextCode) {
            flushText(input.length);
            break;
        }
        if (nextCode === 'triple') {
            const closeIdx = input.indexOf('```', nextIdx + 3);
            if (closeIdx === -1) {
                // Unclosed: treat the rest as plain.
                flushText(input.length);
                break;
            }
            flushText(nextIdx);
            const value = input.slice(nextIdx + 3, closeIdx);
            nodes.push({ type: 'codeblock', value });
            cursor = closeIdx + 3;
            continue;
        }
        // single backtick
        const closeIdx = input.indexOf('`', nextIdx + 1);
        if (closeIdx === -1) {
            flushText(input.length);
            break;
        }
        flushText(nextIdx);
        const value = input.slice(nextIdx + 1, closeIdx);
        nodes.push({ type: 'code', value });
        cursor = closeIdx + 1;
    }
    return nodes;
}
/**
 * Find next single-backtick, before `limit`, that is NOT part of a triple-backtick.
 * Returns -1 if none.
 */
function findSingleBacktick(s, from, limit) {
    let i = from;
    while (i < limit) {
        const idx = s.indexOf('`', i);
        if (idx === -1 || idx >= limit)
            return -1;
        // Skip if part of a triple-backtick sequence.
        if (s.slice(idx, idx + 3) === '```') {
            i = idx + 3;
            continue;
        }
        if (idx > 0 && s.slice(idx - 1, idx + 2) === '```') {
            // The '`' is the middle of a triple backtick; skip past all three.
            i = idx + 2;
            continue;
        }
        return idx;
    }
    return -1;
}
/**
 * Deepest nesting of format markers the parser will honour. A hostile message can alternate
 * openers (`*_*_*_…`) to nest thousands of levels, or repeat segments (`*a* *a* …`) to queue
 * thousands of sibling splits; an unbounded recursive descent overflows the call stack and
 * freezes the tab. Segments at one level are emitted iteratively (no stack growth), and past
 * this depth the remaining content falls back to a literal text node — markers and all — so
 * the message still renders, just without the deeper formatting.
 */
const MAX_FORMAT_DEPTH = 20;
/**
 * Emit a text leaf, splitting out the `MENTION_OPEN...MENTION_CLOSE` spans resolveMentions wraps a
 * resolved name in as `mention` nodes. An unterminated marker stays literal text.
 */
function pushText(nodes, value) {
    let cursor = 0;
    while (cursor < value.length) {
        const open = value.indexOf(MENTION_OPEN, cursor);
        const close = open === -1 ? -1 : value.indexOf(MENTION_CLOSE, open + 1);
        if (close === -1) {
            nodes.push({ type: 'text', value: value.slice(cursor) });
            break;
        }
        if (open > cursor)
            nodes.push({ type: 'text', value: value.slice(cursor, open) });
        nodes.push({ type: 'mention', value: value.slice(open + 1, close) });
        cursor = close + 1;
    }
    return nodes;
}
/** Index of the MENTION_CLOSE ending a span that opens at `i`, or -1 when no span opens there. */
function mentionEnd(input, i) {
    return input[i] === MENTION_OPEN ? input.indexOf(MENTION_CLOSE, i + 1) : -1;
}
/**
 * Parse a text segment (no code in it) for *bold*, _italic_, ~strike~.
 * Inner content is parsed again (depth-bounded) so *_a_* nests; sibling segments after a
 * formatted span are handled by the loop, not by recursion.
 */
function parseFormatting(input, depth = 0) {
    if (input.length === 0)
        return [];
    if (depth >= MAX_FORMAT_DEPTH)
        return pushText([], input);
    const nodes = [];
    // Shared across the loop because every `rest` is a suffix of `input`, so a marker that found no
    // closer stays without one; not shared with the recursive call, whose `inner` ends earlier.
    const exhausted = new Set();
    let rest = input;
    while (rest.length > 0) {
        const split = splitFirstFormat(rest, exhausted);
        if (!split) {
            pushText(nodes, rest);
            break;
        }
        if (split.before)
            pushText(nodes, split.before);
        nodes.push({ type: split.fmt, children: parseFormatting(split.inner, depth + 1) });
        rest = split.after;
    }
    return nodes;
}
/**
 * Locate the first usable format span: an opening marker (`*`, `_`, `~`) with a valid boundary
 * on the outside and a non-whitespace char immediately inside, paired with the first closing
 * marker satisfying the same boundary rules. Returns the text before the span, the format, the
 * inner content, and the unconsumed remainder — or null when the segment holds no valid span
 * (unbalanced or boundary-violating markers stay literal).
 *
 * `exhausted` holds the markers an earlier opener already scanned to the end without a closer. A
 * closer's validity depends only on its neighbours, so a later opener of the same marker would see
 * a subset of those candidates and cannot succeed either; skipping it keeps the parse linear instead
 * of rescanning the rest of the message for every unmatched opener.
 */
function splitFirstFormat(input, exhausted) {
    for (let i = 0; i < input.length; i++) {
        const skip = mentionEnd(input, i);
        if (skip !== -1) {
            i = skip;
            continue;
        }
        const ch = input[i];
        const fmt = FORMATS[ch];
        if (!fmt || exhausted.has(ch))
            continue;
        // Boundary outside the opener: previous char must be a boundary or string-start.
        const prev = i === 0 ? '' : input[i - 1];
        if (prev !== '' && !BOUNDARY_CHAR.test(prev))
            continue;
        // Char immediately inside (right after the opener) must NOT be whitespace.
        const inside = input[i + 1];
        if (!inside || /\s/.test(inside))
            continue;
        // Find the matching closing marker.
        for (let j = i + 1; j < input.length; j++) {
            const skipInner = mentionEnd(input, j);
            if (skipInner !== -1) {
                j = skipInner;
                continue;
            }
            if (input[j] !== ch)
                continue;
            // Char immediately before closer must NOT be whitespace.
            const beforeCloser = input[j - 1];
            if (/\s/.test(beforeCloser))
                continue;
            // Boundary after closer: must be boundary or string-end.
            const after = j === input.length - 1 ? '' : input[j + 1];
            if (after !== '' && !BOUNDARY_CHAR.test(after))
                continue;
            return {
                before: input.slice(0, i),
                fmt,
                inner: input.slice(i + 1, j),
                after: input.slice(j + 1),
            };
        }
        // No matching closer for this opener, so none for any later one of the same marker either.
        exhausted.add(ch);
    }
    return null;
}
