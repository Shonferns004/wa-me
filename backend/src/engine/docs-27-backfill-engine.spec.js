"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const engine_capability_matrix_1 = require("./engine-capability-matrix");
/**
 * docs/27 tells search-provider authors to backfill through `ctx.engine.*` calls. Those calls go
 * straight to the active engine adapter, so a method the capability matrix marks not-available on
 * an engine rejects there with `EngineNotSupportedError`. The page must say so next to the method,
 * or an author on that engine follows the documented path and every call fails.
 */
describe('docs/27 names the engines its ctx.engine backfill path does not work on', () => {
    const repoRoot = (0, node_path_1.join)(__dirname, '..', '..');
    const doc = (0, node_fs_1.readFileSync)((0, node_path_1.join)(repoRoot, 'docs', '27-plugin-search-providers.md'), 'utf8');
    const paragraphs = doc.split(/\n\s*\n/);
    const matrix = (0, engine_capability_matrix_1.engineCapabilityMatrix)();
    const engineName = { wwjs: 'whatsapp-web.js', baileys: 'Baileys' };
    const methods = [...new Set([...doc.matchAll(/ctx\.engine\.(\w+)\(/g)].map(match => match[1]))];
    it('finds the ctx.engine calls the page documents', () => {
        expect(methods).toEqual(expect.arrayContaining(['getChats', 'getChatHistory']));
    });
    const gaps = methods.flatMap(method => ['wwjs', 'baileys']
        .filter(engine => matrix[method]?.[engine].status === 'not-available')
        .map(engine => [method, engineName[engine]]));
    it.each(gaps)('says `%s` rejects on %s', (method, engine) => {
        const qualified = paragraphs.some(paragraph => paragraph.includes(`\`${method}\``) &&
            paragraph.includes(engine) &&
            paragraph.includes('EngineNotSupportedError'));
        expect(qualified).toBe(true);
    });
});
