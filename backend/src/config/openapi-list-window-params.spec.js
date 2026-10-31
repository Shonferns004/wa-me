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
/**
 * A list route's `limit` and `offset` are integer counts: the handlers read them with parseInt and
 * resolveListWindow clamps the result. A parameter published as a string types a generated client's
 * argument as text. No range is asserted on purpose: the server clamps out-of-range values rather
 * than refusing them, so a published minimum or maximum would make a validating client refuse what
 * the server accepts.
 */
const OPERATION_KEYS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const snapshot = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.json'), 'utf8'));
describe('openapi.json list-window query parameters', () => {
    it('publishes every limit and offset query parameter as an integer', () => {
        const notInteger = [];
        let seen = 0;
        for (const [route, item] of Object.entries(snapshot().paths)) {
            for (const [method, operation] of Object.entries(item)) {
                if (!OPERATION_KEYS.has(method))
                    continue;
                for (const p of operation.parameters ?? []) {
                    if (p.in !== 'query' || (p.name !== 'limit' && p.name !== 'offset'))
                        continue;
                    seen++;
                    if (p.schema?.type !== 'integer') {
                        notInteger.push(`${method.toUpperCase()} ${route} ${p.name}: ${p.schema?.type}`);
                    }
                }
            }
        }
        // Vacuity guard: a parse that found no parameter would pass the comparison below.
        expect(seen).toBeGreaterThanOrEqual(20);
        expect(notInteger).toEqual([]);
    });
});
