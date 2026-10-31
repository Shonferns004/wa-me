"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLUGIN_SEARCH_REGISTRY_PORT = exports.PLUGIN_INSTANCE_PORT = exports.PLUGIN_CONVERSATION_MAPPING_PORT = exports.PLUGIN_SESSION_PORT = exports.PLUGIN_MESSAGE_PORT = void 0;
/** Message send/history surface, bound to MessageService by MessageModule. */
exports.PLUGIN_MESSAGE_PORT = Symbol('PLUGIN_MESSAGE_PORT');
/** Session engine resolution, bound to SessionService by SessionModule. */
exports.PLUGIN_SESSION_PORT = Symbol('PLUGIN_SESSION_PORT');
/** Conversation mapping verbs, bound to ConversationMappingService by PluginsModule (its provider home). */
exports.PLUGIN_CONVERSATION_MAPPING_PORT = Symbol('PLUGIN_CONVERSATION_MAPPING_PORT');
/** Provisioned-instance lookup, bound to PluginInstanceService by IntegrationModule. */
exports.PLUGIN_INSTANCE_PORT = Symbol('PLUGIN_INSTANCE_PORT');
/** Search-registry mutations, bound to SearchProviderRegistry by SearchModule. */
exports.PLUGIN_SEARCH_REGISTRY_PORT = Symbol('PLUGIN_SEARCH_REGISTRY_PORT');
