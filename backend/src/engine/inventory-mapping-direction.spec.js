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
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const ts = __importStar(require("typescript"));
const engine_capability_matrix_1 = require("./engine-capability-matrix");
/**
 * The DIRECTION of the docs/29 §29.5 inventory: a row saying "`groupMetadata` → `getGroupInfo`,
 * `getGroups`" claims both interface methods reach that library symbol.
 *
 * `engine-inventory-parity.spec.js` cannot judge that — it asks whether the symbol is used at all,
 * and its own docblock records direction as a blind spot. Thirteen rows were sitting in it: `logout`
 * credited to `initialize` and `disconnect` (the only mentions there are in comments),
 * `setProfilePicture` credited to `setGroupPicture` (whose code comment says the opposite —
 * "GroupChat.setPicture, NOT Client.setProfilePicture"), `archiveChat` credited to
 * `clearChatMessages` (which calls `Chat.clearMessages()`), and ten more.
 *
 * Regex cannot answer this: the call usually sits in a private helper, so the question is
 * reachability through the adapter's own call graph. This walks the adapter ASTs, records which
 * methods touch a library symbol through a handle, and closes over `this.…()` calls.
 *
 * Direction is checked ONE WAY, deliberately. Over-listing is a false claim — a reader is told a
 * method uses a symbol it cannot reach. Under-listing is not: a row naming four of eight callers is
 * incomplete, not wrong, and the sibling spec already documents exhaustiveness as a non-goal.
 */
const ADAPTER_DIR = (0, node_path_1.join)(__dirname, 'adapters');
const DOC = (0, node_path_1.join)(__dirname, '..', '..', 'docs', '29-engine-capability-matrix.md');
/** Library handles include `this.sock()`, `this.sock!`, `getSocket()`, and a captured `socket` local. */
const HANDLE = {
    wwjs: /^(?:client|.*Client)$/i,
    baileys: /^(?:sock|socket|.*Sock|getSocket)$/i,
};
function isHandle(expr, engine) {
    let node = expr;
    // A cast or a non-null assertion still leaves a handle underneath: `(this.client() as X).m()`,
    // `this.sock!.m()`. Missing either produced false positives on real call sites.
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
        node = node.expression;
    }
    if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        return HANDLE[engine].test(name);
    }
    if (ts.isIdentifier(node))
        return HANDLE[engine].test(node.text);
    if (ts.isPropertyAccessExpression(node))
        return HANDLE[engine].test(node.name.text);
    return false;
}
/**
 * The engine an adapter file belongs to, or undefined for a module both adapters share. Mirrors the
 * attribution in engine-parity.spec.ts, which also fails on an unprefixed file nobody attributed.
 */
function fileEngine(file) {
    if (file.startsWith('baileys') || file === 'safe-link-preview.js')
        return 'baileys';
    if (file.startsWith('wwebjs-') || file.startsWith('whatsapp-web-js') || file === 'chromium-profile-hygiene.js') {
        return 'wwjs';
    }
    return undefined;
}
/**
 * One engine's call graph. Methods are keyed by bare name and every interface method has the same name
 * in both adapters, so a graph over both would union their call edges and credit one engine with a
 * symbol only the other's implementation reaches.
 */
function buildGraph(engine) {
    const methods = new Map();
    const files = (0, node_fs_1.readdirSync)(ADAPTER_DIR).filter(f => f.endsWith('.js') && !f.endsWith('.spec.js') && (fileEngine(f) ?? engine) === engine);
    for (const file of files) {
        const source = ts.createSourceFile(file, (0, node_fs_1.readFileSync)((0, node_path_1.join)(ADAPTER_DIR, file), 'utf8'), ts.ScriptTarget.ES2022, true);
        const visit = (node) => {
            if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
                const name = node.name.text;
                const facts = methods.get(name) ?? {
                    lib: { wwjs: new Set(), baileys: new Set() },
                    calls: new Set(),
                    strings: new Set(),
                    computed: { wwjs: false, baileys: false },
                };
                methods.set(name, facts);
                const walk = (n) => {
                    if (ts.isPropertyAccessExpression(n)) {
                        for (const engine of ['wwjs', 'baileys']) {
                            if (isHandle(n.expression, engine))
                                facts.lib[engine].add(n.name.text);
                        }
                        if (n.expression.kind === ts.SyntaxKind.ThisKeyword)
                            facts.calls.add(n.name.text);
                        else if (ts.isPropertyAccessExpression(n.expression) &&
                            n.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
                            facts.calls.add(n.name.text);
                        }
                    }
                    if (ts.isElementAccessExpression(n)) {
                        for (const engine of ['wwjs', 'baileys']) {
                            if (isHandle(n.expression, engine))
                                facts.computed[engine] = true;
                        }
                    }
                    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
                        facts.strings.add(n.text);
                    ts.forEachChild(n, walk);
                };
                if (node.body)
                    walk(node.body);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return methods;
}
const GRAPHS = { baileys: buildGraph('baileys'), wwjs: buildGraph('wwjs') };
/** Every adapter method that reaches `symbol`, directly or through its own helpers. */
function reachers(symbol, engine) {
    const GRAPH = GRAPHS[engine];
    const reached = new Set([...GRAPH]
        .filter(([, f]) => f.lib[engine].has(symbol) || (f.computed[engine] && f.strings.has(symbol)))
        .map(([n]) => n));
    // Computed dispatch is usually split: a helper holds `handle[op](…)` while its caller supplies the
    // literal. Credit both when a method naming the symbol calls such a helper.
    const namers = [...GRAPH].filter(([, f]) => f.strings.has(symbol)).map(([n]) => n);
    for (const [helper, facts] of GRAPH) {
        if (!facts.computed[engine])
            continue;
        for (const namer of namers) {
            if (GRAPH.get(namer)?.calls.has(helper)) {
                reached.add(helper);
                reached.add(namer);
            }
        }
    }
    for (let grew = true; grew;) {
        grew = false;
        for (const [name, facts] of GRAPH) {
            if (reached.has(name))
                continue;
            for (const callee of facts.calls) {
                if (reached.has(callee)) {
                    reached.add(name);
                    grew = true;
                    break;
                }
            }
        }
    }
    return reached;
}
function inventoryRows(engine) {
    const doc = (0, node_fs_1.readFileSync)(DOC, 'utf8');
    const matrix = (0, engine_capability_matrix_1.engineCapabilityMatrix)();
    const start = doc.indexOf(engine === 'baileys' ? '### 29.5.1' : '### 29.5.2');
    const end = doc.indexOf(engine === 'baileys' ? '### 29.5.2' : '### 29.5.3');
    const rows = [];
    for (const line of doc.slice(start, end).split('\n')) {
        const m = /^\|\s*`([^`]+)`\s*\|\s*(✅.*?)\s*\|\s*$/.exec(line);
        if (!m)
            continue;
        const listed = [...m[2].matchAll(/`([a-zA-Z][\w]*)`/g)].map(x => x[1]).filter(name => name in matrix);
        if (listed.length)
            rows.push({ symbol: m[1], listed });
    }
    return rows;
}
describe('docs/29 §29.5 inventory — the interface methods a row names can reach its symbol', () => {
    it.each([
        ['socket', true],
        ['this.sock!', true],
        ['this.sock(socket)', true],
        ['getSocket()', true],
        ['this.addChatLabel()', false],
        ['store', false],
        ['socketStore', false],
    ])('classifies the Baileys handle %s', (expression, expected) => {
        const source = ts.createSourceFile('sample.js', `${expression};`, ts.ScriptTarget.ES2022, true);
        const statement = source.statements[0];
        expect(isHandle(statement.expression, 'baileys')).toBe(expected);
        expect(isHandle(statement.expression, 'wwjs')).toBe(false);
    });
    it.each(['baileys', 'wwjs'])('the AST walk found the %s adapter methods', engine => {
        // Without this the reachability sets are empty and every assertion below passes vacuously.
        expect(GRAPHS[engine].size).toBeGreaterThan(150);
    });
    it('does not credit one engine with a symbol only the other engine reaches', () => {
        // Every interface method has the same name in both adapters. Baileys reaches `onWhatsApp` from
        // getNumberId and the shared send path; unrelated reads must not borrow the wwjs call edges.
        expect(reachers('onWhatsApp', 'baileys').has('getNumberId')).toBe(true);
        expect(reachers('onWhatsApp', 'baileys').has('sendTextMessage')).toBe(true);
        expect(reachers('onWhatsApp', 'baileys').has('getContacts')).toBe(false);
        expect(reachers('getBlockedContacts', 'wwjs').has('getContacts')).toBe(false);
    });
    describe.each(['baileys', 'wwjs'])('%s', engine => {
        it('names no interface method that cannot reach the symbol', () => {
            const rows = inventoryRows(engine);
            // Guard the parser: a reworded table would make the check vacuous.
            expect(rows.length).toBeGreaterThan(20);
            const overListed = rows
                .map(row => {
                const reached = reachers(row.symbol, engine);
                const extra = row.listed.filter(name => !reached.has(name));
                return extra.length ? `${row.symbol}: names ${extra.join(', ')}, which cannot reach it` : null;
            })
                .filter((x) => x !== null);
            expect(overListed).toEqual([]);
        });
    });
});
