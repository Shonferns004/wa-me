"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatchCapabilityVerb = dispatchCapabilityVerb;
/**
 * Dispatch a worker-initiated capability `verb` to the live, permission-enforcing context the loader
 * built for this plugin. Allowlisted by design: only the verbs below are reachable, so a hostile
 * worker cannot invoke an arbitrary method on the context. Args are positional, one per signature.
 *
 * Permission + session-scope checks are NOT here — they live inside the context's own verbs
 * (assertPermission / assertSessionActive), so a sandboxed call is gated exactly like an in-process
 * one. This router is purely the wire-to-method mapping.
 */
async function dispatchCapabilityVerb(context, verb, args) {
    // Worker args cross a trust boundary: validate here so a malformed RPC fails the calling plugin
    // with a clear error instead of reaching the ORM with undefined criteria (TypeORM 1.x throws on
    // those, and older versions silently DROPPED them — matching rows it should never have matched).
    const s = (index) => {
        const v = args[index];
        if (typeof v !== 'string' || v.length === 0) {
            throw new Error(`Capability ${verb}: argument ${index} must be a non-empty string`);
        }
        return v;
    };
    const mappingKey = (index) => {
        const k = args[index];
        if (!k || [k.sessionId, k.chatId, k.instanceId].some(v => typeof v !== 'string' || v.length === 0)) {
            throw new Error(`Capability ${verb}: argument ${index} must be { sessionId, chatId, instanceId } strings`);
        }
        return k;
    };
    switch (verb) {
        case 'messages.sendText':
            return context.messages.sendText(s(0), s(1), s(2));
        case 'messages.reply':
            return context.messages.reply(s(0), s(1), s(2), s(3));
        case 'engine.getGroupInfo':
            return context.engine.getGroupInfo(s(0), s(1));
        case 'engine.getContacts':
            return context.engine.getContacts(s(0));
        case 'engine.getContactById':
            return context.engine.getContactById(s(0), s(1));
        case 'engine.checkNumberExists':
            return context.engine.checkNumberExists(s(0), s(1));
        case 'engine.getChats':
            return context.engine.getChats(s(0));
        case 'engine.getChatHistory':
            return context.engine.getChatHistory(s(0), s(1), args[2], args[3]);
        case 'engine.canonicalChatId':
            return context.engine.canonicalChatId(s(0), s(1));
        case 'storage.get':
            return context.storage.get(s(0));
        case 'storage.set':
            return context.storage.set(s(0), args[1]);
        case 'storage.delete':
            return context.storage.delete(s(0));
        case 'storage.list':
            return context.storage.list(args[0]);
        case 'net.fetch':
            return context.net.fetch(s(0), args[1]);
        case 'conversation.send':
            return context.conversations.send(args[0]);
        case 'handover.set': {
            // Only 'human'/'closed' hold a chat, so any other value would be stored and silently never take over.
            const key = mappingKey(0);
            const state = args[1];
            if (state !== 'bot' && state !== 'human' && state !== 'closed') {
                throw new Error(`Capability ${verb}: argument 1 must be 'bot', 'human' or 'closed'`);
            }
            return context.handover.set(key, state);
        }
        case 'mappings.upsert':
            return context.mappings.upsert(mappingKey(0), s(1));
        case 'mappings.get':
            return context.mappings.get(mappingKey(0));
        case 'mappings.getByProvider':
            return context.mappings.getByProvider(s(0), s(1));
        default:
            throw new Error(`Unknown capability verb: ${verb}`);
    }
}
