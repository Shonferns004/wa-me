"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MUST_STAY_MARKED = exports.MUST_STAY_UNMARKED = exports.QUOTED_ALLOWED_GRANTS = exports.AGNOSTIC_GRANTS = exports.GUARD_BODY_CHAT_FIELDS = exports.GUARD_CHAT_ROUTE_PARAMS = void 0;
exports.quotedAllowedHandlers = quotedAllowedHandlers;
exports.chatScopedHandlers = chatScopedHandlers;
exports.chatScopeViolations = chatScopeViolations;
// Structural guard for the chat-scope class of bug: a key restricted with `allowedChats` must not
// reach a chat outside its fence.
//
// The guard is DEFAULT DENY (api-key.guard.ts): a chat-restricted key is refused with 403 on every
// handler that is not marked @ChatScoped, so surfaces with no chat dimension (webhooks, automation
// rules, status, key management, channels, Bull Board) and every route added later stay closed
// without being enumerated.
//
// Marking carries the reason, and this spec checks each one:
//
//   @ChatScoped('fenced')    the handler names a chat the guard inspects — a `:chatId` / `:groupId` /
//                            `:contactId` path param, or a REQUIRED guard-read body field
//                            (`chatId` / `fromChatId` / `toChatId` / `messages[]`). An optional
//                            `?chatId=` qualifies only when the handler also calls
//                            `this.chatScope.requireChat(`, which refuses a restricted key that omits
//                            it; on its own the guard would have nothing to check.
//   @ChatScoped('filtered')  the handler narrows a chat-typed result set to the key's chats: a list
//                            route returns through ChatScopeService.filter, and a query surface
//                            (search) passes ChatScopeService.idsForFilter into the provider so the
//                            filter applies before limit/offset/total.
//   @ChatScoped('agnostic')  the handler cannot reach a chat at all. This is the one category the
//                            spec cannot derive (a webhook with `events: ['*']` also names no chat),
//                            so every grant must also appear in AGNOSTIC_GRANTS.
//
// Every @ChatScoped decorator must pair with a parsed handler (the non-vacuity check below), so a
// decorator the parser cannot see fails rather than silently going unchecked.
const fs_1 = require("fs");
const path_1 = require("path");
/** Route params the ApiKeyGuard treats as a chat id. Asserted against the guard's own source below. */
exports.GUARD_CHAT_ROUTE_PARAMS = ['chatId', 'groupId', 'contactId'];
/** Body fields the ApiKeyGuard treats as a chat id (bulk send nests `chatId` inside `messages[]`). */
exports.GUARD_BODY_CHAT_FIELDS = ['chatId', 'fromChatId', 'toChatId'];
/**
 * The complete set of handlers granted `@ChatScoped('agnostic')`. Each entry is a deliberate access
 * decision, so the spec fails if a grant is missing from here OR listed here without the mark.
 * Key format: `<controller file basename> :: <handler name>`.
 */
exports.AGNOSTIC_GRANTS = [
    // Reports the session's own state and account: no chat data, changes nothing, and an integration
    // needs it to know whether its session is connected.
    ['session.controller.js', 'findOne'],
];
/**
 * The complete set of handlers granted `@ChatQuotedAllowed()`: routes whose `quotedMessageId` is
 * bound to the chat they send into, so a quote cannot name a chat outside the allowlist. Every entry
 * is a deliberate decision; the spec fails if a grant is unused or unlisted.
 */
exports.QUOTED_ALLOWED_GRANTS = [
    // Reply requires a quotedMessageId and both engines resolve it inside the named chat.
    ['message.controller.js', 'reply'],
];
/**
 * Handlers that must stay UNMARKED, so default-deny keeps refusing them. The group routes would pass
 * the category checks if marked 'fenced' (`:groupId` counts as a chat param), which is why they are
 * pinned; the batch routes are pinned so that marking them stays a deliberate decision.
 */
exports.MUST_STAY_UNMARKED = [
    // Adding a participant can DM them an invite (whatsapp-web.js autoSendInviteV4), a chat the
    // guard never sees; the other three change who belongs to a group outside the key's own chats.
    ['group.controller.js', 'addParticipants'],
    ['group.controller.js', 'removeParticipants'],
    ['group.controller.js', 'promoteParticipants'],
    ['group.controller.js', 'demoteParticipants'],
    // A join request comes from a number outside the key's chats: listing the queue names them, and
    // approving or rejecting decides whether they join, the same membership change refused above.
    ['group.controller.js', 'getMembershipRequests'],
    ['group.controller.js', 'approveMembershipRequests'],
    ['group.controller.js', 'rejectMembershipRequests'],
    // An invite link admits anyone who holds it, no request to decide, and keeps working after the key
    // is revoked; revoking returns a fresh link, so both routes hand the key the same capability.
    ['group.controller.js', 'getInviteCode'],
    ['group.controller.js', 'revokeInviteCode'],
    // A batch row has no key owner, so its status and cancel cannot be checked against an allowlist.
    ['message.controller.js', 'getBatchStatus'],
    ['message.controller.js', 'cancelBatch'],
];
/** Handlers that must stay marked with the given category; a lost mark silently becomes a 403. */
exports.MUST_STAY_MARKED = [
    // Live history, whatsapp-web.js only.
    ['message.controller.js', 'getChatHistory', 'fenced'],
    // Stored history on both engines, for the chat named in ?chatId=.
    ['message.controller.js', 'getMessages', 'fenced'],
    // List routes a restricted key may use, each filtered to its chats before paging.
    ['session.controller.js', 'getChats', 'filtered'],
    ['session.controller.js', 'getGroups', 'filtered'],
    ['contact.controller.js', 'findAll', 'filtered'],
    ['label.controller.js', 'getChatsByLabel', 'filtered'],
    // Search narrows hits to the key's chats inside the providers, before limit/offset/total; the
    // optional ?chatId= is fenced by the guard on top of that.
    ['search.controller.js', 'search', 'filtered'],
    // Group detail and settings for a group the key may already read and write into: the roster is
    // member-visible data, largely inferable from the group's own messages.
    ['group.controller.js', 'findOne', 'fenced'],
    ['group.controller.js', 'getSettings', 'fenced'],
    ['group.controller.js', 'updateSettings', 'fenced'],
    // Message sends, actions and the reads of one chat. A lost mark answers 403 on the key's OWN chat, so
    // a refusal-only check never sees it.
    ['message.controller.js', 'sendText', 'fenced'],
    ['message.controller.js', 'sendTemplate', 'fenced'],
    ['message.controller.js', 'sendImage', 'fenced'],
    ['message.controller.js', 'sendVideo', 'fenced'],
    ['message.controller.js', 'sendAudio', 'fenced'],
    ['message.controller.js', 'sendDocument', 'fenced'],
    ['message.controller.js', 'sendLocation', 'fenced'],
    ['message.controller.js', 'sendContact', 'fenced'],
    ['message.controller.js', 'sendSticker', 'fenced'],
    ['message.controller.js', 'sendPoll', 'fenced'],
    ['message.controller.js', 'reply', 'fenced'],
    ['message.controller.js', 'clickButton', 'fenced'],
    ['message.controller.js', 'forward', 'fenced'],
    ['message.controller.js', 'sendBulk', 'fenced'],
    ['message.controller.js', 'react', 'fenced'],
    ['message.controller.js', 'edit', 'fenced'],
    ['message.controller.js', 'deleteMessage', 'fenced'],
    ['message.controller.js', 'pinMessage', 'fenced'],
    ['message.controller.js', 'unpinMessage', 'fenced'],
    ['message.controller.js', 'starMessage', 'fenced'],
    ['message.controller.js', 'votePoll', 'fenced'],
    ['message.controller.js', 'getReactions', 'fenced'],
    ['message.controller.js', 'getChatMedia', 'fenced'],
    // Chat actions and the presence of one chat.
    ['session.controller.js', 'markChatRead', 'fenced'],
    ['session.controller.js', 'markChatUnread', 'fenced'],
    ['session.controller.js', 'archiveChat', 'fenced'],
    ['session.controller.js', 'muteChat', 'fenced'],
    ['session.controller.js', 'pinChat', 'fenced'],
    ['session.controller.js', 'deleteChat', 'fenced'],
    ['session.controller.js', 'sendChatState', 'fenced'],
    ['session.controller.js', 'clearChatMessages', 'fenced'],
    ['session.controller.js', 'subscribeToPresence', 'fenced'],
    ['session.controller.js', 'getPresence', 'fenced'],
];
const REQUIRED_GUARD_FIELD = new RegExp(`\\b(?:${exports.GUARD_BODY_CHAT_FIELDS.join('|')})!\\s*:`);
const REQUIRED_BULK_FIELD = /\bmessages!\s*:/;
/** Request DTO classes carrying a REQUIRED guard-read chat field. */
function requiredGuardChatDtos(dir) {
    const own = new Set();
    const parents = new Map();
    const walk = (current) => {
        for (const entry of (0, fs_1.readdirSync)(current, { withFileTypes: true })) {
            const full = (0, path_1.join)(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.name.endsWith('.js') || entry.name.endsWith('.spec.js'))
                continue;
            for (const chunk of (0, fs_1.readFileSync)(full, 'utf8')
                .split(/export\s+class\s+/)
                .slice(1)) {
                const name = /^([A-Za-z0-9_]+)/.exec(chunk)?.[1];
                if (!name)
                    continue;
                const parent = /^[A-Za-z0-9_]+\s+extends\s+([A-Za-z0-9_]+)/.exec(chunk)?.[1];
                if (parent)
                    parents.set(name, parent);
                if (REQUIRED_GUARD_FIELD.test(chunk) || REQUIRED_BULK_FIELD.test(chunk))
                    own.add(name);
            }
        }
    };
    walk(dir);
    // Resolve `extends` transitively: a DTO inheriting a fenced `chatId` counts (send-audio extends the
    // media DTO). Anything unresolved or cyclic is simply not required.
    const out = new Set();
    for (const name of [...own, ...parents.keys()]) {
        let cursor = name;
        const seen = new Set();
        while (cursor && !seen.has(cursor)) {
            seen.add(cursor);
            if (own.has(cursor)) {
                out.add(name);
                break;
            }
            cursor = parents.get(cursor);
        }
    }
    return out;
}
/** Every handler carrying `@ChatQuotedAllowed()` in `source`. */
function quotedAllowedHandlers(source) {
    const out = [];
    const handlerRe = /((?:^ {2}@[\s\S]*?)?)^ {2}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(/gm;
    for (let m = handlerRe.exec(source); m !== null; m = handlerRe.exec(source)) {
        if (/@ChatQuotedAllowed\(\)/.test(m[1] ?? ''))
            out.push(m[2]);
    }
    return out;
}
/** Every @ChatScoped decorator in `source` paired with the handler it decorates. */
function chatScopedHandlers(source) {
    const out = [];
    const handlerRe = /((?:^ {2}@[\s\S]*?)?)^ {2}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*[:{]/gm;
    const matches = [];
    for (let m = handlerRe.exec(source); m !== null; m = handlerRe.exec(source)) {
        matches.push({ name: m[2], from: m.index, decorators: m[1] ?? '' });
    }
    for (let i = 0; i < matches.length; i++) {
        const kind = /@ChatScoped\(\s*'([a-z]+)'\s*\)/.exec(matches[i].decorators)?.[1];
        if (kind === undefined)
            continue;
        out.push({
            name: matches[i].name,
            kind,
            body: source.slice(matches[i].from, matches[i + 1]?.from ?? source.length),
        });
    }
    return out;
}
/** Return a description of every marked handler that does not hold up its declared category. */
function chatScopeViolations(source, file, requiredDtos, agnosticGrants = exports.AGNOSTIC_GRANTS) {
    const offenders = [];
    for (const { name, kind, body } of chatScopedHandlers(source)) {
        const hasPathChat = new RegExp(`@Param\\(\\s*['"](?:${exports.GUARD_CHAT_ROUTE_PARAMS.join('|')})['"]\\s*\\)`).test(body);
        const bodyDto = /@Body\(\)\s*[A-Za-z0-9_]+\s*:\s*([A-Za-z0-9_]+)/.exec(body)?.[1];
        const hasRequiredBodyChat = bodyDto !== undefined && requiredDtos.has(bodyDto);
        const hasRequiredQueryChat = /@Query\(\s*['"]chatId['"]\s*\)/.test(body) && /this\.chatScope\.requireChat\(/.test(body);
        if (kind === 'fenced' && !(hasPathChat || hasRequiredBodyChat || hasRequiredQueryChat))
            offenders.push(`${name} (fenced, no guard-read chat)`);
        else if (kind === 'filtered' && !/chatScope\.(filter|idsForFilter)\(/.test(body))
            offenders.push(`${name} (filtered, no filter)`);
        else if (kind === 'agnostic' && !agnosticGrants.some(([f, h]) => f === file && h === name))
            offenders.push(`${name} (agnostic, not on AGNOSTIC_GRANTS)`);
        else if (!['fenced', 'filtered', 'agnostic'].includes(kind))
            offenders.push(`${name} (unknown kind '${kind}')`);
    }
    return offenders;
}
function listControllerFiles(dir) {
    const out = [];
    for (const entry of (0, fs_1.readdirSync)(dir, { withFileTypes: true })) {
        const full = (0, path_1.join)(dir, entry.name);
        if (entry.isDirectory())
            out.push(...listControllerFiles(full));
        else if (entry.name.endsWith('.controller.js') && !entry.name.endsWith('.spec.js'))
            out.push(full);
    }
    return out;
}
describe('a chat-restricted key can only reach a handler fenced to its allowedChats', () => {
    it('the guard denies by default and fences every chat id it can see', () => {
        const guard = (0, fs_1.readFileSync)((0, path_1.join)(__dirname, 'guards', 'api-key.guard.js'), 'utf8');
        expect(guard).toContain('CHAT_SCOPED_KEY');
        expect(guard).toContain('API key is restricted to selected chats');
        for (const param of exports.GUARD_CHAT_ROUTE_PARAMS)
            expect(guard).toContain(`'${param}'`);
        for (const field of exports.GUARD_BODY_CHAT_FIELDS)
            expect(guard).toContain(`'${field}'`);
        expect(guard).toContain("['chatId']");
        expect(guard).toContain('messages');
        // A chat reference the guard cannot fence is refused outright.
        expect(guard).toContain('quotedMessageId');
    });
    it("flags a 'fenced' handler that names no guard-read chat", () => {
        const source = `
  @ChatScoped('fenced')
  @Post('status')
  async postStatus(@Body() dto: StatusDto): Promise<unknown> {
    return this.svc.post(dto);
  }
`;
        expect(chatScopeViolations(source, 'x.controller.js', new Set())).toEqual([
            'postStatus (fenced, no guard-read chat)',
        ]);
    });
    it("flags a 'fenced' handler whose only chat is an optional query param", () => {
        const source = `
  @ChatScoped('fenced')
  @Get()
  async list(@Query('chatId') chatId?: string): Promise<unknown> {
    return this.svc.list(chatId);
  }
`;
        expect(chatScopeViolations(source, 'x.controller.js', new Set())).toEqual(['list (fenced, no guard-read chat)']);
    });
    it("clears a 'fenced' optional query chat only when the handler requires it", () => {
        const required = `
  @ChatScoped('fenced')
  @Get()
  async list(@Query('chatId') chatId?: string, @CurrentApiKey() apiKey?: ApiKey): Promise<unknown> {
    this.chatScope.requireChat(apiKey, chatId);
    return this.svc.list(chatId);
  }
`;
        expect(chatScopeViolations(required, 'x.controller.js', new Set())).toEqual([]);
        const noQuery = `
  @ChatScoped('fenced')
  @Get()
  async list(@CurrentApiKey() apiKey?: ApiKey): Promise<unknown> {
    this.chatScope.requireChat(apiKey, undefined);
    return this.svc.list();
  }
`;
        expect(chatScopeViolations(noQuery, 'x.controller.js', new Set())).toEqual(['list (fenced, no guard-read chat)']);
    });
    it("flags a 'filtered' handler that does not filter and an unlisted 'agnostic'", () => {
        const source = `
  @ChatScoped('filtered')
  @Get('chats')
  async chats(): Promise<unknown> {
    return this.svc.chats();
  }

  @ChatScoped('agnostic')
  @Get('profile')
  async profile(): Promise<unknown> {
    return this.svc.profile();
  }
`;
        expect(chatScopeViolations(source, 'x.controller.js', new Set())).toEqual([
            'chats (filtered, no filter)',
            'profile (agnostic, not on AGNOSTIC_GRANTS)',
        ]);
    });
    it('clears a fenced path chat, a required body chat, a filter, and a listed agnostic grant', () => {
        const source = `
  @ChatScoped('fenced')
  @Get(':chatId')
  async getOne(@Param('chatId') chatId: string): Promise<unknown> {
    return this.svc.get(chatId);
  }

  @ChatScoped('fenced')
  @Post()
  async send(@Body() dto: SendThingDto): Promise<unknown> {
    return this.svc.send(dto);
  }

  @ChatScoped('filtered')
  @Get('chats')
  async chats(@CurrentApiKey() apiKey: ApiKey): Promise<unknown> {
    return this.chatScope.filter(apiKey, await this.svc.chats(), c => c.id);
  }

  @ChatScoped('agnostic')
  @Get('granted')
  async granted(): Promise<unknown> {
    return this.svc.granted();
  }
`;
        expect(chatScopeViolations(source, 'x.controller.js', new Set(['SendThingDto']), [['x.controller.js', 'granted']])).toEqual([]);
    });
    it('keeps the pinned handlers unmarked, and the pinned marks in place', () => {
        const sources = new Map(listControllerFiles((0, path_1.join)(__dirname, '..')).map(f => [(0, path_1.basename)(f), (0, fs_1.readFileSync)(f, 'utf8')]));
        const marks = (file) => {
            const source = sources.get(file);
            if (source === undefined)
                throw new Error(`${file} not found`);
            return new Map(chatScopedHandlers(source).map(({ name, kind }) => [name, kind]));
        };
        for (const [file, name] of [...exports.MUST_STAY_UNMARKED, ...exports.MUST_STAY_MARKED]) {
            // A renamed handler must fail here rather than leave the pin checking nothing.
            expect({
                file,
                name,
                found: new RegExp(`^ {2}(?:async\\s+)?${name}\\s*\\(`, 'm').test(sources.get(file) ?? ''),
            }).toEqual({
                file,
                name,
                found: true,
            });
        }
        for (const [file, name] of exports.MUST_STAY_UNMARKED)
            expect({ file, name, kind: marks(file).get(name) }).toEqual({ file, name, kind: undefined });
        for (const [file, name, kind] of exports.MUST_STAY_MARKED)
            expect({ file, name, kind: marks(file).get(name) }).toEqual({ file, name, kind });
    });
    it('pairs every decorator with a parsed handler, and the scan is not vacuous', () => {
        const modulesDir = (0, path_1.join)(__dirname, '..');
        const requiredDtos = requiredGuardChatDtos(modulesDir);
        expect(requiredDtos.size).toBeGreaterThan(0); // the DTO scan must not silently collapse
        const files = listControllerFiles(modulesDir);
        expect(files.length).toBeGreaterThan(10);
        const offenders = [];
        const seenGrants = new Set();
        const seenQuoted = new Set();
        let marked = 0;
        for (const file of files) {
            const source = (0, fs_1.readFileSync)(file, 'utf8');
            const fileName = (0, path_1.basename)(file);
            const posixPath = file
                .split(path_1.sep)
                .join('/')
                .replace(/.*\/src\//, 'src/');
            // Non-vacuity: every @ChatScoped decorator in the file must pair with a parsed handler, or the
            // parser is blind to it and the category checks never run.
            const decorators = [...source.matchAll(/@ChatScoped\(/g)].length;
            const paired = chatScopedHandlers(source);
            expect({ file: posixPath, decorators, paired: paired.length }).toEqual({
                file: posixPath,
                decorators: paired.length,
                paired: paired.length,
            });
            marked += paired.length;
            for (const { name, kind } of paired)
                if (kind === 'agnostic')
                    seenGrants.add(`${fileName} :: ${name}`);
            for (const name of quotedAllowedHandlers(source))
                seenQuoted.add(`${fileName} :: ${name}`);
            for (const violation of chatScopeViolations(source, fileName, requiredDtos)) {
                offenders.push(`${posixPath} :: ${fileName} :: ${violation}`);
            }
        }
        // 61 when written: a lost mark closes a route to every chat-restricted key, so the count may only grow.
        expect(marked).toBeGreaterThanOrEqual(61);
        expect(offenders).toEqual([]);
        // Every declared grant is used, and every used grant is declared.
        expect([...seenGrants].sort()).toEqual(exports.AGNOSTIC_GRANTS.map(([f, h]) => `${f} :: ${h}`).sort());
        expect([...seenQuoted].sort()).toEqual(exports.QUOTED_ALLOWED_GRANTS.map(([f, h]) => `${f} :: ${h}`).sort());
    });
});
