"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveJidCandidates = resolveJidCandidates;
const wa_id_1 = require("./wa-id");
async function resolveJidCandidates(value, directory) {
    const parsed = (0, wa_id_1.parseWaId)(value);
    // Group ids are stored in the neutral `<id>@g.us` form, so normalize rather than echo the input:
    // an upper-case domain must not make the guard's answer disagree with the list filter's.
    if (parsed.kind === 'group')
        return [`${parsed.userPart}@g.us`];
    // Only a bare number is qualified into the user dialects; an unrecognised domain is not a phone.
    if (parsed.kind !== 'user' && parsed.kind !== 'lid' && (parsed.kind !== 'unknown' || value.includes('@'))) {
        return [value];
    }
    if (parsed.kind === 'lid') {
        // Start from the neutral `<lid>@lid`, not the raw input, for the same reason (an upper-case
        // domain or a `:device` suffix must still match the stored form).
        const candidates = new Set([`${parsed.userPart}@lid`]);
        const resolved = await directory?.resolveLid(parsed.userPart);
        if (resolved) {
            candidates.add(`${resolved}@c.us`);
            candidates.add(`${resolved}@s.whatsapp.net`);
        }
        return [...candidates];
    }
    const phone = parsed.userPart;
    const candidates = new Set([value, `${phone}@c.us`, `${phone}@s.whatsapp.net`]);
    for (const lid of (await directory?.lidsForPhone(phone)) ?? []) {
        candidates.add(`${lid}@lid`);
    }
    return [...candidates];
}
