"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const audit_log_entity_1 = require("./entities/audit-log.entity");
const intentionally_unemitted_actions_1 = require("./intentionally-unemitted-actions");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * Structural gate: every `AuditAction` enum member must either be emitted somewhere in
 * `src/` (an `AuditAction.<NAME>` literal at a real call site) or be registered in
 * `INTENTIONALLY_UNEMITTED_ACTIONS` with a reason. This keeps the audit vocabulary honest —
 * an enum value that implies an audited event cannot silently exist with no emission site,
 * and new values cannot be added without either wiring them or documenting why they are held back.
 */
const SRC_DIR = (0, node_path_1.join)(__dirname, '..', '..');
function listTsFiles(dir, out = []) {
    for (const ent of (0, node_fs_1.readdirSync)(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules')
            continue;
        const full = (0, node_path_1.join)(dir, ent.name);
        if (ent.isDirectory()) {
            listTsFiles(full, out);
        }
        else if (ent.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}
const isExcluded = (file) => file.endsWith('.spec.js') ||
    file.endsWith('.test.js') ||
    file.endsWith('audit-coverage.spec.js') ||
    file.endsWith('audit-log.entity.js') ||
    file.endsWith('intentionally-unemitted-actions.js');
const sourceBodies = listTsFiles(SRC_DIR)
    .filter(file => !isExcluded(file))
    .map(file => (0, node_fs_1.readFileSync)(file, 'utf8'));
const memberKeys = Object.keys(audit_log_entity_1.AuditAction);
const isEmitted = (key) => key !== undefined && sourceBodies.some(body => body.includes(`AuditAction.${key}`));
const memberKeyForValue = (value) => memberKeys.find(k => audit_log_entity_1.AuditAction[k] === value);
describe('audit action emit coverage', () => {
    it.each(memberKeys)('AuditAction.%s is emitted somewhere in src/ or registered as intentionally unemitted', key => {
        const registered = Boolean(intentionally_unemitted_actions_1.INTENTIONALLY_UNEMITTED_ACTIONS[audit_log_entity_1.AuditAction[key]]);
        expect(isEmitted(key) || registered).toBe(true);
    });
    it('intentionally-unemitted registry has no stale entries (none is actually emitted)', () => {
        const stale = Object.keys(intentionally_unemitted_actions_1.INTENTIONALLY_UNEMITTED_ACTIONS)
            .map(value => memberKeyForValue(value))
            .filter((key) => Boolean(key) && isEmitted(key));
        expect(stale).toEqual([]);
    });
    // Filtering GET /api/audit for an unemitted action silently returns nothing, so the API docs must
    // name every one of them.
    it('docs/06 names every intentionally-unemitted action in the GET /api/audit description', () => {
        const docs = (0, node_fs_1.readFileSync)((0, node_path_1.join)(SRC_DIR, '..', 'docs', '06-api-specification.md'), 'utf8');
        const paragraph = docs.split('\n').find(line => line.startsWith('List audit-log entries, newest first.')) ?? '';
        const missing = Object.keys(intentionally_unemitted_actions_1.INTENTIONALLY_UNEMITTED_ACTIONS).filter(value => !paragraph.includes(`\`${value}\``));
        expect(paragraph).not.toBe('');
        expect(missing).toEqual([]);
    });
    it('intentionally-unemitted registry entries each carry a non-empty reason', () => {
        const empties = Object.entries(intentionally_unemitted_actions_1.INTENTIONALLY_UNEMITTED_ACTIONS)
            .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length === 0)
            .map(([value]) => value);
        expect(empties).toEqual([]);
    });
});
