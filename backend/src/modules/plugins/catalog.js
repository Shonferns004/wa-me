"use strict";
// Remote plugin catalog: the shape of an entry in the OpenWA-plugins `plugins.json`, and the pure
// logic that annotates each entry with install state relative to what is currently loaded.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCatalogEntry = isCatalogEntry;
exports.compareSemver = compareSemver;
exports.annotateCatalog = annotateCatalog;
const OPTIONAL_STRING_FIELDS = [
    'type',
    'status',
    'description',
    'author',
    'license',
    'minOpenWAVersion',
    'testedOpenWAVersion',
    'releasedAt',
    'repoUrl',
    'homepage',
    'download',
];
/**
 * Whether `value` has the shape of {@link CatalogEntry}: non-empty string id, name and version, string
 * optional fields, and a string-array `keywords`; a null optional field counts as absent, as a hand-written
 * catalog often has it. Extra fields are tolerated. The dashboard lists and
 * searches these fields as text, so a value of another type would break the page that renders them.
 */
function isCatalogEntry(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const entry = value;
    const text = (field) => typeof field === 'string' && field !== '';
    return (text(entry.id) &&
        text(entry.name) &&
        text(entry.version) &&
        OPTIONAL_STRING_FIELDS.every(key => entry[key] == null || typeof entry[key] === 'string') &&
        (entry.keywords == null ||
            (Array.isArray(entry.keywords) && entry.keywords.every(word => typeof word === 'string'))));
}
/** The entry without the optional fields a catalog left null, so none is answered as null where a string is declared. */
function withoutNulls(entry) {
    const out = { ...entry };
    for (const key of [...OPTIONAL_STRING_FIELDS, 'keywords']) {
        if (out[key] === null)
            delete out[key];
    }
    return out;
}
/** Compare two `MAJOR.MINOR.PATCH` strings (pre-release suffixes ignored). Returns -1 | 0 | 1. */
function compareSemver(a, b) {
    const parse = (v) => String(v)
        .split('-')[0]
        .split('.')
        .map(n => Number.parseInt(n, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d > 0 ? 1 : -1;
    }
    return 0;
}
/**
 * Annotate catalog entries with install state, given the plugins currently loaded by this instance.
 * `updateAvailable` is true when an entry is installed and the catalog version is strictly newer. A final
 * release counts as newer than an installed prerelease of the same version, which compareSemver alone
 * would call equal.
 */
function annotateCatalog(entries, installed) {
    const byId = new Map(installed.map(p => [p.id, p.version]));
    return entries.map(entry => {
        const installedVersion = byId.get(entry.id) ?? null;
        const cmp = installedVersion === null ? 0 : compareSemver(entry.version, installedVersion);
        return {
            ...withoutNulls(entry),
            installed: installedVersion !== null,
            installedVersion,
            updateAvailable: installedVersion !== null &&
                (cmp > 0 || (cmp === 0 && installedVersion.includes('-') && !String(entry.version).includes('-'))),
        };
    });
}
