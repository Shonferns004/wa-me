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
 * Structural invariants of the committed snapshot.
 *
 * `openapi:check` proves the file matches a fresh export; it cannot say whether either is correct.
 * These assert properties the specification requires, so a regression fails here rather than in a
 * consumer's generator.
 */
const OPERATION_KEYS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const snapshot = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.json'), 'utf8'));
describe('openapi.json structural invariants', () => {
    it('message send responses document recipient lookup failures', () => {
        const routes = [];
        for (const [route, item] of Object.entries(snapshot().paths)) {
            const responses = item.post?.responses ?? {};
            const sendsMessage = ['200', '201'].some(status => {
                const response = responses[status];
                if (!response || '$ref' in response)
                    return false;
                const schema = response.content?.['application/json']?.schema;
                return schema && '$ref' in schema && schema.$ref.endsWith('/MessageResponseDto');
            });
            if (!sendsMessage)
                continue;
            routes.push(route);
            expect(responses['503']).toBeDefined();
        }
        expect(routes.length).toBeGreaterThan(0);
    });
    // OpenAPI 3.0 requires every template expression in a path to resolve to a declared path parameter,
    // on the path item or on the operation. A route whose handler never binds the parameter — a
    // class-level prefix nothing reads, or a wildcard read off the request — publishes the template with
    // nothing to fill it, and a generated client has no argument for that segment.
    it('every path template variable is declared as a path parameter', () => {
        const doc = snapshot();
        const undeclared = [];
        for (const [route, item] of Object.entries(doc.paths)) {
            const templated = [...route.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
            if (!templated.length)
                continue;
            const itemLevel = (item.parameters ?? [])
                .filter(p => 'in' in p && p.in === 'path')
                .map(p => ('name' in p ? p.name : ''));
            for (const [method, operation] of Object.entries(item)) {
                if (!OPERATION_KEYS.has(method))
                    continue;
                const declared = new Set([
                    ...itemLevel,
                    ...(operation.parameters ?? [])
                        .filter(p => p.in === 'path')
                        .map(p => p.name ?? ''),
                ]);
                for (const variable of templated) {
                    if (!declared.has(variable))
                        undeclared.push(`${method.toUpperCase()} ${route} → {${variable}}`);
                }
            }
        }
        expect(undeclared).toEqual([]);
    });
    // OpenAPI 3.0 requires a parameter to carry a schema; without one a generator has no type for the
    // argument. Every path parameter in the document had one except the four added alongside this spec,
    // which is exactly the blind spot a structural check exists to close.
    it('every path parameter declares a schema type', () => {
        const doc = snapshot();
        const untyped = [];
        for (const [route, item] of Object.entries(doc.paths)) {
            const declared = [...(item.parameters ?? [])];
            for (const [method, operation] of Object.entries(item)) {
                if (!OPERATION_KEYS.has(method))
                    continue;
                declared.push(...(operation.parameters ??
                    []));
            }
            for (const p of declared) {
                if (p.in === 'path' && !p.schema?.type)
                    untyped.push(`${route} -> ${p.name}`);
            }
        }
        expect(untyped).toEqual([]);
    });
    // Every participant write goes through runParticipantsUpdate, which spends the shared request
    // budget (baileys-groups.ts), so each can answer 503 — and each ALSO reports per-participant
    // refusals inside its 200, which is the neighbouring claim it is easiest to mistake the 503 for.
    // Keyed off the response schema rather than a list of paths: these four were missed when the rest
    // of the module gained its 503s, and a hand-written list would miss a fifth route the same way.
    it('every participant write documents the 503 its request budget can produce', () => {
        const doc = snapshot();
        const participantWrites = [];
        const undocumented = [];
        for (const [route, item] of Object.entries(doc.paths)) {
            for (const [method, operation] of Object.entries(item)) {
                if (!OPERATION_KEYS.has(method))
                    continue;
                const responses = operation
                    .responses ?? {};
                const ref = responses['200']?.content?.['application/json']?.schema?.$ref;
                if (!ref?.endsWith('/ParticipantsOperationResponseDto'))
                    continue;
                const id = `${method.toUpperCase()} ${route}`;
                participantWrites.push(id);
                if (!responses['503'])
                    undocumented.push(id);
            }
        }
        // A renamed DTO would match nothing and leave the assertion below vacuously true — an empty
        // result from a selector that can no longer match is not evidence of compliance.
        expect(participantWrites.length).toBeGreaterThan(0);
        expect(undocumented).toEqual([]);
    });
    it('every operation declares at least one response', () => {
        const doc = snapshot();
        const silent = Object.entries(doc.paths).flatMap(([route, item]) => Object.entries(item)
            .filter(([method]) => OPERATION_KEYS.has(method))
            .filter(([, operation]) => !Object.keys(operation.responses ?? {}).length)
            .map(([method]) => `${method.toUpperCase()} ${route}`));
        expect(silent).toEqual([]);
    });
    it('never types a timestamp property as a bare object', () => {
        const doc = snapshot();
        // A `Date | null` member with no explicit @ApiProperty type is emitted as `type: object`, and the
        // published schema then rejects the ISO string the gateway actually sends. Restricted to
        // timestamp-named properties: the document's other bare objects are genuine Record maps, and the
        // Unix-seconds fields are legitimately `type: number`.
        const scanned = [];
        const bare = [];
        for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
            const properties = schema.properties ?? {};
            for (const [property, spec] of Object.entries(properties)) {
                if (!/(At|Timestamp)$/.test(property))
                    continue;
                scanned.push(`${name}.${property}`);
                if (spec.type === 'object')
                    bare.push(`${name}.${property}`);
            }
        }
        // Guard the selector: if the naming convention changed, this would scan nothing and pass.
        expect(scanned.length).toBeGreaterThan(20);
        expect(bare).toEqual([]);
    });
    it('declares nullability on every property whose description offers null', () => {
        const doc = snapshot();
        // A property documented as carrying null must publish it, or a client generated from the
        // contract rejects a value the gateway both sends and accepts. `lastTriggeredAt` was fixed that
        // way; `filters` — stored as `dto.filters ?? null` for every webhook created without one — was
        // the sibling left behind, which is why this is an invariant rather than three more spellings.
        //
        // A container satisfies it through its members: `pictures` is never null, but its values are,
        // and it declares that on additionalProperties.
        const scanned = [];
        const undeclared = [];
        for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
            const properties = schema.properties ?? {};
            for (const [property, spec] of Object.entries(properties)) {
                if (!/\bnull\b/i.test(spec.description ?? ''))
                    continue;
                scanned.push(`${name}.${property}`);
                const member = typeof spec.additionalProperties === 'object' ? spec.additionalProperties : spec.items;
                if (spec.nullable !== true && member?.nullable !== true)
                    undeclared.push(`${name}.${property}`);
            }
        }
        // Guard the selector: a description reworded away from the word would scan nothing and pass.
        expect(scanned.length).toBeGreaterThan(15);
        expect(undeclared).toEqual([]);
    });
    it('gives every API-key operation its auth refusals and an error body schema', () => {
        const doc = snapshot();
        let checked = 0;
        const gaps = [];
        for (const [route, item] of Object.entries(doc.paths)) {
            for (const [method, op] of Object.entries(item)) {
                if (!OPERATION_KEYS.has(method) || op.security !== undefined)
                    continue;
                checked++;
                const responses = op.responses ?? {};
                for (const status of ['401', '403'])
                    if (!responses[status])
                        gaps.push(`${method} ${route} lacks ${status}`);
                for (const [status, response] of Object.entries(responses)) {
                    if (Number(status) >= 400 && !response.$ref && !response.content)
                        gaps.push(`${method} ${route} ${status}`);
                }
            }
        }
        expect(checked).toBeGreaterThan(150);
        expect(gaps).toEqual([]);
    });
    it('gives each route exactly one path key, whatever its parameters are named', () => {
        const doc = snapshot();
        // A path template variable is positional: `/x/{id}` and `/x/{sessionId}` are the same URL. Two
        // keys for one route split its operations across two Path Items, and a generator emits two
        // endpoints where the gateway has one.
        const byShape = new Map();
        for (const route of Object.keys(doc.paths)) {
            const shape = route.replace(/\{[^}]*\}/g, '{}');
            byShape.set(shape, [...(byShape.get(shape) ?? []), route]);
        }
        // Guard the grouping: a document that somehow parsed to nothing must not pass silently.
        expect(byShape.size).toBeGreaterThan(100);
        expect([...byShape.values()].filter(routes => routes.length > 1)).toEqual([]);
    });
});
// The document is produced in TWO places: scripts/export-openapi.ts for the committed snapshot, and
// src/main.ts for the live /api/docs. The schema-validity pass was added to the export only, so a
// running gateway kept serving a document that fails validation while the artifact was clean. A
// structural check, because neither producer is reachable from a unit test.
describe('both OpenAPI producers apply the same passes', () => {
    const PASSES = ['dropUnexpressibleOperations', 'exemptPublicOperations', 'documentErrorResponses'];
    const producers = ['src/main.js', 'scripts/export-openapi.js'];
    it.each(PASSES)('%s runs in every producer', pass => {
        const missing = producers.filter(file => !fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').includes(`${pass}(`));
        expect(missing).toEqual([]);
    });
    it('applies them in the same order in both', () => {
        for (const file of producers) {
            const text = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
            const order = PASSES.map(p => text.indexOf(`${p}(document`) >= 0 ? text.indexOf(`${p}(document`) : text.indexOf(`${p}(doc`));
            // drop must precede exempt: exempting an operation about to be deleted is wasted work, and the
            // reverse order would leave a security exemption attached to nothing. The error pass reads
            // the exemption, so it runs last.
            expect(order[0]).toBeGreaterThan(-1);
            for (let i = 1; i < order.length; i++)
                expect(order[i]).toBeGreaterThan(order[i - 1]);
        }
    });
});
/**
 * A request body must publish a SCHEMA, not a primitive.
 *
 * `@ApiBody({ description })` with no `type:` publishes `{"type":"string"}` — the decorator has no
 * way to infer the DTO — so the published contract told every generated client the body was a bare
 * string while the handler took an object. `openapi:check` passes on it happily: the snapshot is
 * self-consistent, just wrong. One of the document's application/json bodies was in that state.
 */
describe('every JSON request body publishes an object schema', () => {
    const jsonBodies = () => {
        const out = [];
        for (const [path, item] of Object.entries(snapshot().paths)) {
            for (const [method, op] of Object.entries(item)) {
                const body = op
                    .requestBody;
                const schema = body?.content?.['application/json']?.schema;
                if (schema)
                    out.push({ op: `${method.toUpperCase()} ${path}`, schema });
            }
        }
        return out;
    };
    // Guards the assertion below: an extractor that found nothing would pass it vacuously.
    it('finds the document’s JSON request bodies', () => {
        expect(jsonBodies().length).toBeGreaterThan(50);
    });
    it('publishes none of them as a bare primitive', () => {
        const primitives = jsonBodies()
            .filter(({ schema }) => !schema.$ref && !schema.properties && schema.type !== 'object')
            .map(({ op, schema }) => `${op} -> ${JSON.stringify(schema)}`);
        expect(primitives).toEqual([]);
    });
});
/**
 * A published `example` is what a reader pastes into Swagger's "Try it out", so an example its own
 * route rejects is worse than no example at all: the first request against a new endpoint answers
 * `400`, and the schema that caused it says nothing about why. `CreateWebhookDto.secret` offered a
 * 15-character example under a 16-character floor, which is exactly how it was found
 * ([#1491](https://github.com/rmyndharis/OpenWA/issues/1491)).
 *
 * Only length is checked here. It is the constraint a hand-written example actually drifts past, and
 * it needs no validator: the bound and the example sit in the same schema object. The sweep covers
 * the top-level string properties of each component schema, which is where a hand-written
 * `@ApiProperty` example lives; nested and composed schemas are out of its reach.
 */
describe('every published string example fits its own schema', () => {
    const examples = () => {
        const schemas = (snapshot().components?.schemas ?? {});
        const out = [];
        for (const [name, schema] of Object.entries(schemas)) {
            for (const [property, spec] of Object.entries(schema.properties ?? {})) {
                if (spec.type === 'string' && typeof spec.example === 'string') {
                    out.push({ where: `${name}.${property}`, example: spec.example, min: spec.minLength, max: spec.maxLength });
                }
            }
        }
        return out;
    };
    const bounded = () => examples().filter(({ min, max }) => min !== undefined || max !== undefined);
    // Guards the assertion below twice over: an extractor that found no examples would pass it
    // vacuously, and so would one that found examples but never a schema that bounds their length.
    it('finds the document’s string examples, and the bounded ones among them', () => {
        expect(examples().length).toBeGreaterThan(200);
        expect(bounded().length).toBeGreaterThan(9);
    });
    it('publishes none of them outside its own minLength/maxLength', () => {
        const violations = bounded()
            .filter(({ example, min, max }) => (min !== undefined && example.length < min) || (max !== undefined && example.length > max))
            .map(({ where, example, min, max }) => `${where}: ${JSON.stringify(example)} is ${example.length} chars, bounds [${min ?? '-'}, ${max ?? '-'}]`);
        expect(violations).toEqual([]);
    });
});
