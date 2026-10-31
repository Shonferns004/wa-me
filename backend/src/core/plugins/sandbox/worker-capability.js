"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerCapabilityClient = void 0;
exports.buildSandboxContext = buildSandboxContext;
const worker_hooks_1 = require("./worker-hooks");
/**
 * Worker-side correlation for capability calls. Each `call` posts a `cap` request and resolves when
 * the host's matching `cap-result` arrives. The mirror of the host's PluginWorkerHost correlation.
 */
class WorkerCapabilityClient {
    post;
    nextId = 1;
    pending = new Map();
    constructor(post) {
        this.post = post;
    }
    call(verb, args) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const inFlight = worker_hooks_1.hookConfigStore.getStore()?.inFlight;
            // Post before registering: an uncloneable arg throws here (rejecting this promise), and an entry
            // registered first would never be removed, since no cap-result can come back for it.
            this.post(inFlight ? { kind: 'cap', id, verb, args, inFlight } : { kind: 'cap', id, verb, args });
            this.pending.set(id, { resolve, reject });
        });
    }
    handleResult(message) {
        const waiter = this.pending.get(message.id);
        if (!waiter)
            return;
        this.pending.delete(message.id);
        if (message.ok)
            waiter.resolve(message.result);
        else
            waiter.reject(new Error(message.error));
    }
}
exports.WorkerCapabilityClient = WorkerCapabilityClient;
/** Build the proxy capability context handed to a sandboxed plugin in the worker. */
function buildSandboxContext(client) {
    return {
        messages: {
            sendText: (sessionId, chatId, text) => client.call('messages.sendText', [sessionId, chatId, text]),
            reply: (sessionId, chatId, quotedMessageId, text) => client.call('messages.reply', [sessionId, chatId, quotedMessageId, text]),
        },
        engine: {
            getGroupInfo: (sessionId, groupId) => client.call('engine.getGroupInfo', [sessionId, groupId]),
            getContacts: sessionId => client.call('engine.getContacts', [sessionId]),
            getContactById: (sessionId, contactId) => client.call('engine.getContactById', [sessionId, contactId]),
            checkNumberExists: (sessionId, phone) => client.call('engine.checkNumberExists', [sessionId, phone]),
            getChats: sessionId => client.call('engine.getChats', [sessionId]),
            getChatHistory: (sessionId, chatId, limit, includeMedia) => client.call('engine.getChatHistory', [sessionId, chatId, limit, includeMedia]),
            canonicalChatId: (sessionId, chatId) => client.call('engine.canonicalChatId', [sessionId, chatId]),
        },
        storage: {
            get: key => client.call('storage.get', [key]),
            set: (key, value) => client.call('storage.set', [key, value]),
            delete: key => client.call('storage.delete', [key]),
            list: prefix => client.call('storage.list', [prefix]),
        },
        net: {
            fetch: (url, init) => client.call('net.fetch', [url, init]),
        },
        conversations: {
            send: env => client.call('conversation.send', [env]),
        },
        handover: {
            set: (key, state) => client.call('handover.set', [key, state]),
        },
        mappings: {
            upsert: (key, providerConversationId) => client.call('mappings.upsert', [key, providerConversationId]),
            get: key => client.call('mappings.get', [key]),
            getByProvider: (instanceId, providerConversationId) => client.call('mappings.getByProvider', [instanceId, providerConversationId]),
        },
    };
}
