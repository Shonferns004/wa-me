"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const testing_1 = require("@nestjs/testing");
const plugins_module_1 = require("./plugins.module");
const integration_module_1 = require("../../modules/integration/integration.module");
const message_module_1 = require("../../modules/message/message.module");
const search_module_1 = require("../../modules/search/search.module");
const session_module_1 = require("../../modules/session/session.module");
/**
 * Every PLUGIN_*_PORT must be registered with `useExisting`, never a factory that returns the
 * service instance. Nest dispatches onModuleInit/onApplicationBootstrap/onModuleDestroy once per
 * non-alias provider, and only `useExisting` is an alias: a factory port ran SessionService's
 * hooks twice, launching two concurrent auto-start loops on every boot. The same applies to any other
 * factory that returns an injected instance (search.module.ts `SEARCH_BOOTSTRAP` returns the registry):
 * harmless while the target has no lifecycle hook, doubled the moment one is added.
 *
 * `useExisting` is typed `any`, so unlike the factory it replaced it does NOT check that the service
 * still satisfies the port. That check lives on the classes instead: each one carries
 * `implements Plugin*Port`, so a signature drift fails `tsc --noEmit` rather than surfacing as a
 * runtime TypeError inside a plugin capability call.
 */
describe('plugin host port providers', () => {
    const MODULES = [plugins_module_1.PluginsModule, integration_module_1.IntegrationModule, message_module_1.MessageModule, search_module_1.SearchModule, session_module_1.SessionModule];
    it('registers every PLUGIN_*_PORT as a useExisting alias', () => {
        const ports = [];
        for (const module of MODULES) {
            const providers = Reflect.getMetadata('providers', module) ?? [];
            for (const provider of providers) {
                if (typeof provider !== 'object' || provider === null || !('provide' in provider))
                    continue;
                const token = provider.provide;
                const name = typeof token === 'symbol' ? (token.description ?? '') : '';
                if (!/^PLUGIN_.*_PORT$/.test(name))
                    continue;
                ports.push(name);
                expect({ port: name, alias: 'useExisting' in provider, factory: 'useFactory' in provider }).toEqual({
                    port: name,
                    alias: true,
                    factory: false,
                });
            }
        }
        expect(ports.sort()).toEqual([
            'PLUGIN_CONVERSATION_MAPPING_PORT',
            'PLUGIN_INSTANCE_PORT',
            'PLUGIN_MESSAGE_PORT',
            'PLUGIN_SEARCH_REGISTRY_PORT',
            'PLUGIN_SESSION_PORT',
        ]);
    });
    // The same-instance factory shape ran every hook twice under @nestjs/core 11.1.29; only the alias
    // outcome is pinned here, since that is the guarantee the modules above rely on.
    it('runs lifecycle hooks once when the port is a useExisting alias', async () => {
        const PORT = Symbol('PORT');
        const calls = { init: 0, bootstrap: 0, destroy: 0 };
        let Hooked = class Hooked {
            onModuleInit() {
                calls.init++;
            }
            onApplicationBootstrap() {
                calls.bootstrap++;
            }
            onModuleDestroy() {
                calls.destroy++;
            }
        };
        Hooked = __decorate([
            (0, common_1.Injectable)()
        ], Hooked);
        const port = { provide: PORT, useExisting: Hooked };
        let Fixture = class Fixture {
        };
        Fixture = __decorate([
            (0, common_1.Module)({ providers: [Hooked, port] })
        ], Fixture);
        const app = await testing_1.Test.createTestingModule({ imports: [Fixture] }).compile();
        await app.init();
        expect(app.get(PORT)).toBe(app.get(Hooked));
        await app.close();
        expect(calls).toEqual({ init: 1, bootstrap: 1, destroy: 1 });
    });
});
