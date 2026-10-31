"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldDispatchToPlugin = shouldDispatchToPlugin;
// The core deterministically silences OTHER bots once a plugin has taken a conversation over (human) or
// closed it, while exempting the owning plugin so it (e.g. the Chatwoot relay) keeps mirroring. Scoped by
// session+chat, NOT by pluginId: a handover set by one plugin governs every plugin on that chat.
function shouldDispatchToPlugin(handover, callerPluginId) {
    if (!handover)
        return true; // no handover row => bot default => dispatch
    if (handover.handoverState === 'bot')
        return true;
    return handover.pluginId === callerPluginId; // owner exempt; every other plugin silenced
}
