"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateMessageMetadata = updateMessageMetadata;
exports.mergeSentMetadata = mergeSentMetadata;
const typeorm_1 = require("typeorm");
/** Apply a metadata change to the current row without restoring a concurrent archive or revoke. */
async function updateMessageMetadata(repository, where, change) {
    const target = { ...where, type: (0, typeorm_1.Not)('revoked') };
    for (let attempt = 0; attempt < 3; attempt++) {
        const row = await repository.findOne({ where: target });
        if (!row)
            return null;
        const snapshot = row.metadata;
        const metadata = change({ ...snapshot });
        const result = await repository.update({
            ...target,
            metadata: snapshot == null ? (0, typeorm_1.IsNull)() : (0, typeorm_1.Raw)(column => `${column} = :snapshot`, { snapshot: JSON.stringify(snapshot) }),
        }, { metadata: metadata });
        if (result.affected)
            return metadata;
        // Another metadata writer won. Read its result before applying this change again.
    }
    throw new Error('Message metadata changed repeatedly during update');
}
/** An already archived echo keeps its media marker when the REST writer supplies inline bytes. */
function mergeSentMetadata(current, incoming) {
    const media = current.media;
    return { ...current, ...incoming, ...(media?.archived && media.omitted ? { media } : {}) };
}
