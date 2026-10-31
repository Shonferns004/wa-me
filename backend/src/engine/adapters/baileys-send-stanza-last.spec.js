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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ts = __importStar(require("typescript"));
/**
 * mapSendRefusal reports a send that failed on a closed connection as one that sent nothing, which a client
 * may then retry. That is only true while the installed library writes the message stanza as the last
 * thing a send awaits: a later awaited socket step could fail on the same closed connection after the
 * message already went out, and the retry would deliver it twice. This reads the library as installed, so
 * an upgrade that awaits anything after the stanza fails here instead of duplicating messages.
 */
describe('Baileys sendMessage writes the message stanza last', () => {
    const file = path.join(__dirname, '../../../node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const isFunction = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
    /** Every node under `root` matching `match`, not descending into `skip`. */
    function collect(root, match, skip = () => false) {
        const found = [];
        const visit = (node) => {
            if (match(node))
                found.push(node);
            if (!skip(node))
                ts.forEachChild(node, visit);
        };
        ts.forEachChild(root, visit);
        return found;
    }
    /** The function a library binding names, as `const name = async () => ...` or `name: async () => ...`. */
    function named(name) {
        const bindings = collect(source, (node) => (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
            node.name.getText(source) === name &&
            !!node.initializer &&
            isFunction(node.initializer));
        expect(bindings).toHaveLength(1);
        return bindings[0].initializer;
    }
    /** Awaits that run in `fn` itself, not in a function it creates (a callback left running). */
    const ownAwaits = (fn) => collect(fn, ts.isAwaitExpression, node => node !== fn && isFunction(node));
    /** Whether the statement awaiting `step` is followed by a return, so nothing after it in its function runs. */
    function returnsRightAfter(step) {
        const statement = step.parent;
        if (!ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent))
            return false;
        const siblings = statement.parent.statements;
        const next = siblings[siblings.indexOf(statement) + 1];
        return !!next && ts.isReturnStatement(next) && !next.expression;
    }
    /**
     * Awaited steps that can run after `step`: later in the function running it (none when a bare return
     * follows it), then later in every function out to `outer`, which awaits the one before it.
     */
    function awaitedAfter(step, outer) {
        const later = [];
        let innermost = true;
        for (let node = step.parent; node; node = node.parent) {
            if (!isFunction(node))
                continue;
            if (!(innermost && returnsRightAfter(step))) {
                for (const awaited of ownAwaits(node)) {
                    if (awaited.getStart(source) > step.getEnd())
                        later.push(awaited.getText(source).slice(0, 80));
                }
            }
            innermost = false;
            if (node === outer)
                break;
        }
        return later;
    }
    const awaitsCall = (callee) => (node) => ts.isAwaitExpression(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(source) === callee;
    it('awaits nothing in relayMessage once the stanza is written', () => {
        const relayMessage = named('relayMessage');
        const writes = collect(relayMessage, (node) => awaitsCall('sendNode')(node));
        // The newsletter branch and the regular one, each writing its stanza.
        expect(writes.length).toBeGreaterThanOrEqual(2);
        for (const write of writes) {
            expect(write.expression.arguments.map(arg => arg.getText(source))).toEqual(['stanza']);
            expect(awaitedAfter(write, relayMessage)).toEqual([]);
        }
    });
    it('awaits nothing in sendMessage once relayMessage returns', () => {
        const sendMessage = named('sendMessage');
        const relays = collect(sendMessage, (node) => awaitsCall('relayMessage')(node));
        expect(relays).toHaveLength(1);
        expect(awaitedAfter(relays[0], sendMessage)).toEqual([]);
    });
});
