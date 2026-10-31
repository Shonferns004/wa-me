"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PACKAGE_LIMITS = exports.INSTALLABLE_TYPES = exports.RESERVED_PLUGIN_IDS = void 0;
exports.parsePluginPackage = parsePluginPackage;
const adm_zip_1 = __importDefault(require("adm-zip"));
const path = __importStar(require("path"));
const zlib = __importStar(require("zlib"));
const common_1 = require("@nestjs/common");
const plugins_1 = require("../../core/plugins");
Object.defineProperty(exports, "RESERVED_PLUGIN_IDS", { enumerable: true, get: function () { return plugins_1.RESERVED_PLUGIN_IDS; } });
Object.defineProperty(exports, "INSTALLABLE_TYPES", { enumerable: true, get: function () { return plugins_1.INSTALLABLE_TYPES; } });
exports.DEFAULT_PACKAGE_LIMITS = { maxEntries: 200, maxTotalBytes: 20 * 1024 * 1024 };
/**
 * Decompress one zip entry with a hard cap on actual output bytes. An entry that lies about being
 * empty (header.size = 0) is inflated here with zlib `maxOutputLength` set to the caller's cap.
 * Every other entry goes through `getData()`: adm-zip caps a DEFLATED entry at its declared size,
 * but copies a STORED entry at its real length whatever the header says, so output larger than the
 * declared size is rejected here. That keeps every positive-size entry within the declared sum the
 * caller has already checked. A corrupt entry, a CRC mismatch, or a lying-small header throws, and
 * the caller maps that to a clean 400.
 */
function readEntryData(entry, maxBytes) {
    if (entry.header.size === 0 && entry.header.compressedSize > 0) {
        const compressed = entry.getCompressedData();
        if (compressed.length === 0)
            return Buffer.alloc(0);
        // maxOutputLength aborts inflation (ERR_BUFFER_TOO_LARGE) once output exceeds the cap, so a
        // lying size=0 entry cannot grow unbounded in memory before we reject the archive.
        return zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
    }
    const data = entry.getData();
    if (data.length > entry.header.size)
        throw new Error('Entry is larger than its declared size');
    return data;
}
/**
 * Parse + validate an uploaded plugin `.zip` without touching the filesystem. Locates the package
 * root (the shallowest `manifest.json`, so both a flat zip and a single-folder zip work), validates
 * the manifest and id, and resolves every file path defensively (rejects absolute / `..` escapes and
 * over-size archives). The caller writes the returned entries; this function decides what is safe.
 */
function parsePluginPackage(buffer, limits = exports.DEFAULT_PACKAGE_LIMITS) {
    // The constructor reads only the end-of-central-directory record; the central directory itself is
    // parsed lazily by getEntries(), so an archive whose trailer parses and whose directory does not
    // escaped this guard as a plain Error and reached the caller as a 500. Both answer the same
    // question, "is this a readable archive", so both are caught here.
    let files;
    try {
        files = new adm_zip_1.default(buffer).getEntries().filter(e => !e.isDirectory);
    }
    catch {
        throw new common_1.BadRequestException('Uploaded file is not a valid .zip archive');
    }
    if (files.length === 0)
        throw new common_1.BadRequestException('The archive is empty');
    if (files.length > limits.maxEntries)
        throw new common_1.BadRequestException('The archive has too many files');
    // A leading slash makes path.posix.dirname return '/' or '//', so the prefix below would not match
    // the manifest's own name and its declared size would escape the size guard.
    const absolute = files.find(e => e.entryName.startsWith('/'));
    if (absolute)
        throw new common_1.BadRequestException(`Unsafe path in archive: ${absolute.entryName}`);
    // Package root = directory of the shallowest manifest.json (handles flat and single-folder zips).
    const manifestEntry = files
        .filter(e => path.posix.basename(e.entryName) === 'manifest.json')
        .sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length)[0];
    if (!manifestEntry)
        throw new common_1.BadRequestException('The archive has no manifest.json');
    const dir = path.posix.dirname(manifestEntry.entryName);
    const prefix = dir === '.' ? '' : dir + '/';
    // Size guard FIRST, off the declared header sizes, so an archive that declares more than the limit
    // is rejected before any entry, the manifest included, is decompressed. An entry that declares
    // size 0 adds nothing here; readEntryData still inflates it, capped at maxTotalBytes.
    const packaged = files.filter(e => !prefix || e.entryName.startsWith(prefix));
    const declared = packaged.reduce((sum, e) => sum + e.header.size, 0);
    if (declared > limits.maxTotalBytes)
        throw new common_1.BadRequestException('The archive contents exceed the size limit');
    let manifestRaw;
    try {
        manifestRaw = readEntryData(manifestEntry, limits.maxTotalBytes);
    }
    catch {
        // A corrupt / oversized manifest entry must surface as a clean 400, not an uncaught
        // decompression error (BAD_CRC / ERR_BUFFER_TOO_LARGE) that would escape as an HTTP 500.
        throw new common_1.BadRequestException('Plugin package is corrupt or too large to extract');
    }
    let parsed;
    try {
        parsed = JSON.parse(manifestRaw.toString('utf-8'));
    }
    catch {
        throw new common_1.BadRequestException('manifest.json is not valid JSON');
    }
    // The SAME manifest validation the boot-time loader enforces (shape, required string fields, id
    // format + reserved ids, extension-only type, contained `main`) — shared so the two entry points
    // can never drift apart. Mapped to a clean 400 here, never an uncaught TypeError (HTTP 500) on
    // the attacker-controlled install path.
    try {
        (0, plugins_1.validatePluginManifest)(parsed);
    }
    catch (error) {
        throw new common_1.BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const manifest = parsed;
    const entries = [];
    // Normalized paths already taken, NFC-normalized and case-folded because a case- or
    // normalization-insensitive filesystem (APFS, NTFS) writes `Manifest.json` and `manifest.json`, or
    // an NFC and an NFD spelling, to one file. Upper-then-lower also folds characters such as the long
    // s that toLowerCase() leaves alone. Entries are written in order, so a repeat would let a later
    // `z/../manifest.json` replace the manifest validated above.
    const seen = new Set();
    let actualBytes = 0;
    for (const e of packaged) {
        const relPath = e.entryName.slice(prefix.length);
        if (!relPath)
            continue;
        const norm = path.posix.normalize(relPath);
        if (relPath.includes('\\') || norm.startsWith('..') || norm === '..' || path.posix.isAbsolute(norm)) {
            throw new common_1.BadRequestException(`Unsafe path in archive: ${e.entryName}`);
        }
        const key = norm.normalize('NFC').toUpperCase().toLowerCase();
        if (seen.has(key))
            throw new common_1.BadRequestException(`Duplicate path in archive: ${e.entryName}`);
        seen.add(key);
        let data;
        try {
            data = readEntryData(e, limits.maxTotalBytes);
        }
        catch {
            // Corrupt entry (bad CRC / truncated), a lying-small header (zlib ERR_BUFFER_TOO_LARGE), or a
            // lying size=0 entry that exceeds the cap — all must yield a clean 400, never an uncaught
            // decompression error (HTTP 500).
            throw new common_1.BadRequestException('Plugin package is corrupt or too large to extract');
        }
        // Aggregate actual-bytes bound: the declared-sum pre-check above uses header.size (which lying
        // size=0 entries contribute as 0), and the per-entry cap only bounds each entry individually. A
        // crafted archive with many lying-size=0 entries (each just under the per-entry cap) would pass
        // both and accumulate unbounded in `entries` before the function returns. Abort as soon as the
        // running total of decompressed bytes exceeds the cap.
        actualBytes += data.length;
        if (actualBytes > limits.maxTotalBytes) {
            throw new common_1.BadRequestException('Plugin package is too large to extract');
        }
        entries.push({ relPath: norm, data });
    }
    const mainRel = path.posix.normalize(manifest.main);
    if (!entries.some(en => en.relPath === mainRel)) {
        throw new common_1.BadRequestException(`The archive is missing its main file: ${manifest.main}`);
    }
    return { manifest, entries };
}
