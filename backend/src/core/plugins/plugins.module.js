"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginsModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const plugin_loader_service_1 = require("./plugin-loader.service");
const plugin_storage_service_1 = require("./plugin-storage.service");
const conversation_mapping_entity_1 = require("../../modules/integration/entities/conversation-mapping.entity");
const conversation_mapping_service_1 = require("../../modules/integration/conversation-mapping.service");
const plugin_host_ports_1 = require("./plugin-host-ports");
let PluginsModule = class PluginsModule {
};
exports.PluginsModule = PluginsModule;
exports.PluginsModule = PluginsModule = __decorate([
    (0, common_1.Global)() // Make plugin services available everywhere
    ,
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([conversation_mapping_entity_1.ConversationMapping], 'data')],
        // ConversationMappingService lives here (its own module never provides it) and is reached by the
        // plugin runtime only through the core-owned port token, resolved lazily via ModuleRef by
        // PluginHostServices — so neither the service nor the port needs re-exporting.
        providers: [
            plugin_storage_service_1.PluginStorageService,
            plugin_loader_service_1.PluginLoaderService,
            conversation_mapping_service_1.ConversationMappingService,
            // An alias, not a factory, so lifecycle hooks are not dispatched twice on the same instance.
            { provide: plugin_host_ports_1.PLUGIN_CONVERSATION_MAPPING_PORT, useExisting: conversation_mapping_service_1.ConversationMappingService },
        ],
        exports: [plugin_loader_service_1.PluginLoaderService, plugin_storage_service_1.PluginStorageService],
    })
], PluginsModule);
