"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.constantTimeEqual = constantTimeEqual;
const node_crypto_1 = require("node:crypto");
// Per-process random key. Hashing both inputs with the same key before comparing fixes the digest
// length, so timingSafeEqual never sees unequal lengths and there is no early length-mismatch return
// that would leak the expected secret's byte-length through a fast vs slow response. The key is
// random per process so pre-computed digests from outside the process are useless.
const EQ_KEY = (0, node_crypto_1.randomBytes)(32);
/**
 * Constant-time string equality that does NOT leak the expected value's length.
 *
 * `timingSafeEqual` throws on unequal buffer lengths, so the common idiom is to early-return on a
 * length mismatch — but that early return is itself a timing channel: an attacker who can time the
 * call learns whether their candidate matches the expected length. On `@Public` auth surfaces
 * (`/api/metrics` Bearer, ingress `shared-secret`) that turns into "learn the byte-length of the
 * operator's token/secret" in a handful of probes.
 *
 * Hash both inputs with a per-process random key (fixed-length SHA-256 digests) and compare those.
 * The result is the same boolean equality, the value comparison stays constant-time, and the length
 * of either input no longer affects control flow.
 */
function constantTimeEqual(a, b) {
    const ha = (0, node_crypto_1.createHash)('sha256').update(EQ_KEY).update(a).digest();
    const hb = (0, node_crypto_1.createHash)('sha256').update(EQ_KEY).update(b).digest();
    return (0, node_crypto_1.timingSafeEqual)(ha, hb);
}
