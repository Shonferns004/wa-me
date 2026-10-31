"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildConversationSendFacade = buildConversationSendFacade;
const plugin_interfaces_1 = require("./plugin.interfaces");
const MEDIA_TYPES = ['image', 'file', 'audio', 'video', 'voice'];
const isMediaType = (type) => MEDIA_TYPES.includes(type);
const isValidLatitude = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const isValidLongitude = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
const MESSAGE_HOOK_EVENTS = ['message:sending'];
function buildConversationSendFacade(deps) {
    return {
        async send(env) {
            deps.assertPermission(deps.manifest, plugin_interfaces_1.PluginCapabilityPermission.CONVERSATION_SEND);
            const sessionId = env.sessionId;
            if (!sessionId)
                throw new plugin_interfaces_1.PluginCapabilityError('conversation.send: sessionId is required');
            deps.assertSessionActive(sessionId);
            const chatId = env.chatId ?? (await deps.resolveChatId(env));
            return deps.runGuarded(MESSAGE_HOOK_EVENTS, async () => {
                // A location envelope is delivered as a native location pin. Without valid coordinates there
                // is NOTHING to send — reject loudly instead of degrading to an empty text message.
                if (env.type === 'location') {
                    // The plugin location port (ConversationSendDeps, PluginMessagePort) carries no quotedMessageId,
                    // so a location reply would lose its quote. Reject rather than silently drop it (same rule as media).
                    if (env.replyTo) {
                        throw new plugin_interfaces_1.PluginCapabilityError('conversation.send: replyTo is not supported for location messages');
                    }
                    if (!isValidLatitude(env.latitude) || !isValidLongitude(env.longitude)) {
                        throw new plugin_interfaces_1.PluginCapabilityError('conversation.send: type location requires latitude (-90..90) and longitude (-180..180)');
                    }
                    return deps.sendLocation(sessionId, {
                        chatId,
                        latitude: env.latitude,
                        longitude: env.longitude,
                        description: env.text,
                    });
                }
                // A media type carrying a mediaUrl is sent as native media. A media type WITHOUT a mediaUrl has
                // nothing to send as media, so it falls through to the text/reply path — a plugin that puts the
                // URL in `text` as a fallback still delivers a (text) message rather than erroring.
                if (isMediaType(env.type) && env.mediaUrl) {
                    // The plugin media port (ConversationSendDeps, PluginMessagePort) carries no quotedMessageId, so
                    // a media reply would lose its quote. Reject rather than silently drop it.
                    if (env.replyTo) {
                        throw new plugin_interfaces_1.PluginCapabilityError('conversation.send: replyTo is not supported for media messages');
                    }
                    return deps.sendMedia(sessionId, { chatId, url: env.mediaUrl, type: env.type, caption: env.text });
                }
                if (env.replyTo) {
                    return deps.reply(sessionId, { chatId, quotedMessageId: env.replyTo, text: env.text ?? '' });
                }
                // Forwarded only when the plugin actually expressed a choice: MessageService widens the engine
                // call whenever the key is present, so a blanket `linkPreview: undefined` would rewrite the call
                // shape of every plugin send that never asked for a preview.
                return deps.sendText(sessionId, {
                    chatId,
                    text: env.text ?? '',
                    ...(env.linkPreview === undefined ? {} : { linkPreview: env.linkPreview }),
                });
            });
        },
    };
}
