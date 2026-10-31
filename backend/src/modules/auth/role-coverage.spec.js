"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const common_1 = require("@nestjs/common");
const constants_1 = require("@nestjs/common/constants");
const auth_decorators_1 = require("./decorators/auth.decorators");
const api_key_entity_1 = require("./entities/api-key.entity");
const integration_instance_controller_1 = require("../integration/integration-instance.controller");
const redrive_controller_1 = require("../integration/redrive.controller");
const group_controller_1 = require("../group/group.controller");
const contact_controller_1 = require("../contact/contact.controller");
const channel_controller_1 = require("../channel/channel.controller");
const label_controller_1 = require("../label/label.controller");
const profile_controller_1 = require("../profile/profile.controller");
const catalog_controller_1 = require("../catalog/catalog.controller");
const message_controller_1 = require("../message/message.controller");
const session_controller_1 = require("../session/session.controller");
const tools_1 = require("../../core/agent-tools/tools");
// The dashboard's client-side role (seeded from localStorage) is cosmetic UX only — the ACTUAL
// authorization boundary is the backend @RequireRole guard. These assertions lock that the sensitive
// ADMIN-only integration provisioning / redrive surfaces are role-gated server-side at the class level,
// so a tampered client role can never reach them regardless of what the browser claims.
describe('admin controller role coverage (server-side authorization is the real gate)', () => {
    it.each([
        ['IntegrationInstanceController', integration_instance_controller_1.IntegrationInstanceController],
        ['RedriveController', redrive_controller_1.RedriveController],
    ])('%s requires the ADMIN role at the class level', (_name, controller) => {
        expect(Reflect.getMetadata(auth_decorators_1.REQUIRED_ROLE_KEY, controller)).toBe(api_key_entity_1.ApiKeyRole.ADMIN);
    });
});
// A group invite code is a bearer capability, not read data: whoever holds the link joins the group
// on WhatsApp with no OpenWA credential at all, and that membership survives revoking the key that
// fetched the code. Both invite-code routes therefore sit at OPERATOR, like the QR endpoint: the
// reads whose payload is a credential for a system outside OpenWA's authority.
describe('group invite-code role coverage (the code is a capability, not read data)', () => {
    it.each(['getInviteCode', 'revokeInviteCode'])('GroupController.%s requires the OPERATOR role', method => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
        expect(Reflect.getMetadata(auth_decorators_1.REQUIRED_ROLE_KEY, group_controller_1.GroupController.prototype[method])).toBe(api_key_entity_1.ApiKeyRole.OPERATOR);
    });
});
// A number-existence check is an outbound WhatsApp query about a third party, and bulk checks put the
// linked account's standing at risk, so it sits at OPERATOR (the MCP ContactCheckNumber tool too).
// The profile-picture and phone-resolution reads stay open to any key: the dashboard loads avatars
// with a VIEWER key.
describe('contact lookup role coverage', () => {
    it('ContactController.checkNumber requires the OPERATOR role', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
        expect(Reflect.getMetadata(auth_decorators_1.REQUIRED_ROLE_KEY, contact_controller_1.ContactController.prototype.checkNumber)).toBe(api_key_entity_1.ApiKeyRole.OPERATOR);
    });
    it.each(['getProfilePictures', 'getProfilePicture', 'resolvePhone'])('ContactController.%s stays open to any valid key', method => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
        expect(Reflect.getMetadata(auth_decorators_1.REQUIRED_ROLE_KEY, contact_controller_1.ContactController.prototype[method])).toBeUndefined();
    });
});
const atLeastOperator = (role) => role === api_key_entity_1.ApiKeyRole.OPERATOR || role === api_key_entity_1.ApiKeyRole.ADMIN;
// A write route that loses its role gate is open to a read-only VIEWER key and nothing else notices: the
// handler still works and every other gate stays green. So this walks the routes instead of naming them.
// Every handler of these controllers that is not a plain read must require OPERATOR or higher, on the
// handler or on the class. A deliberate exception goes in OPEN_WRITES, keyed `Controller.handler`, with why.
describe('write routes of the channel, group, contact, label, profile and catalog controllers', () => {
    const CONTROLLERS = [
        channel_controller_1.ChannelController,
        group_controller_1.GroupController,
        contact_controller_1.ContactController,
        label_controller_1.LabelController,
        profile_controller_1.ProfileController,
        catalog_controller_1.CatalogController,
    ];
    const OPEN_WRITES = new Map();
    const READS = [common_1.RequestMethod.GET, common_1.RequestMethod.HEAD, common_1.RequestMethod.OPTIONS];
    const writeRoutes = CONTROLLERS.flatMap(controller => Object.getOwnPropertyNames(controller.prototype).flatMap(name => {
        const handler = controller.prototype[name];
        if (typeof handler !== 'function')
            return [];
        // RequestMethod.GET is 0, so "is a route" is an undefined check, not a truthiness check.
        const method = Reflect.getMetadata(constants_1.METHOD_METADATA, handler);
        if (method === undefined || READS.includes(method))
            return [];
        const role = (Reflect.getMetadata(auth_decorators_1.REQUIRED_ROLE_KEY, handler) ??
            Reflect.getMetadata(auth_decorators_1.REQUIRED_ROLE_KEY, controller));
        return [{ id: `${controller.name}.${name}`, role }];
    }));
    it('walks the write routes of every controller (a walk that found none would pass for the wrong reason)', () => {
        // 35 when written: channel 7, group 15, contact 4, label 4, profile 4, catalog 1.
        expect(writeRoutes.length).toBeGreaterThanOrEqual(35);
        for (const controller of CONTROLLERS) {
            expect(writeRoutes.some(route => route.id.startsWith(`${controller.name}.`))).toBe(true);
        }
    });
    it('requires OPERATOR or higher on every write route', () => {
        const open = writeRoutes.filter(route => !atLeastOperator(route.role) && !OPEN_WRITES.has(route.id));
        expect(open.map(route => route.id)).toEqual([]);
    });
    it('keeps no allowance for a route that is gated or gone', () => {
        const stale = [...OPEN_WRITES.keys()].filter(id => !writeRoutes.some(route => route.id === id && !atLeastOperator(route.role)));
        expect(stale).toEqual([]);
    });
});
// The message and session controllers drive the linked WhatsApp account: they send, delete, start, stop,
// log out, hand out the QR code and pair a number. The walk above only asks that a write route is gated at
// all, so it would not see the QR read slipping below OPERATOR, the proxy write sliding from ADMIN to
// OPERATOR, or the presence read losing its explicit VIEWER. These tables state every route's role, so
// removing or changing one mark fails here, and a new route fails until its role is decided.
describe('role of every message and session route', () => {
    const OPEN = 'open'; // no @RequireRole: any valid key may call it
    const MESSAGE_ROLES = {
        getMessages: OPEN,
        sendText: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendTemplate: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendImage: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendVideo: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendAudio: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendDocument: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendLocation: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendContact: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendSticker: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendPoll: api_key_entity_1.ApiKeyRole.OPERATOR,
        reply: api_key_entity_1.ApiKeyRole.OPERATOR,
        clickButton: api_key_entity_1.ApiKeyRole.OPERATOR,
        forward: api_key_entity_1.ApiKeyRole.OPERATOR,
        react: api_key_entity_1.ApiKeyRole.OPERATOR,
        getBatchStatus: OPEN,
        cancelBatch: api_key_entity_1.ApiKeyRole.OPERATOR,
        getChatHistory: OPEN,
        getReactions: OPEN,
        getChatMedia: OPEN,
        deleteMessage: api_key_entity_1.ApiKeyRole.OPERATOR,
        votePoll: api_key_entity_1.ApiKeyRole.OPERATOR,
        pinMessage: api_key_entity_1.ApiKeyRole.OPERATOR,
        unpinMessage: api_key_entity_1.ApiKeyRole.OPERATOR,
        starMessage: api_key_entity_1.ApiKeyRole.OPERATOR,
        edit: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendBulk: api_key_entity_1.ApiKeyRole.OPERATOR,
    };
    const SESSION_ROLES = {
        create: api_key_entity_1.ApiKeyRole.OPERATOR,
        findAll: OPEN,
        findOne: OPEN,
        getConfig: OPEN,
        updateConfig: api_key_entity_1.ApiKeyRole.OPERATOR,
        getProxy: OPEN,
        updateProxy: api_key_entity_1.ApiKeyRole.ADMIN,
        delete: api_key_entity_1.ApiKeyRole.OPERATOR,
        start: api_key_entity_1.ApiKeyRole.OPERATOR,
        stop: api_key_entity_1.ApiKeyRole.OPERATOR,
        logout: api_key_entity_1.ApiKeyRole.OPERATOR,
        forceKill: api_key_entity_1.ApiKeyRole.OPERATOR,
        // A GET, but the QR code links a device to the account, like the invite codes above.
        getQRCode: api_key_entity_1.ApiKeyRole.OPERATOR,
        requestPairingCode: api_key_entity_1.ApiKeyRole.OPERATOR,
        getGroups: OPEN,
        getChats: OPEN,
        markChatRead: api_key_entity_1.ApiKeyRole.OPERATOR,
        subscribeToPresence: api_key_entity_1.ApiKeyRole.OPERATOR,
        setOnlinePresence: api_key_entity_1.ApiKeyRole.OPERATOR,
        getPresence: api_key_entity_1.ApiKeyRole.VIEWER,
        markChatUnread: api_key_entity_1.ApiKeyRole.OPERATOR,
        clearChatMessages: api_key_entity_1.ApiKeyRole.OPERATOR,
        archiveChat: api_key_entity_1.ApiKeyRole.OPERATOR,
        muteChat: api_key_entity_1.ApiKeyRole.OPERATOR,
        pinChat: api_key_entity_1.ApiKeyRole.OPERATOR,
        deleteChat: api_key_entity_1.ApiKeyRole.OPERATOR,
        sendChatState: api_key_entity_1.ApiKeyRole.OPERATOR,
        getStats: OPEN,
    };
    // The role the guard resolves: the handler's own mark, else the class's.
    const rolesOf = (controller) => {
        const prototype = controller.prototype;
        return Object.fromEntries(Object.getOwnPropertyNames(prototype).flatMap(name => {
            const handler = prototype[name];
            if (typeof handler !== 'function')
                return [];
            // RequestMethod.GET is 0, so "is a route" is an undefined check, not a truthiness check.
            if (Reflect.getMetadata(constants_1.METHOD_METADATA, handler) === undefined)
                return [];
            const role = (Reflect.getMetadata(auth_decorators_1.REQUIRED_ROLE_KEY, handler) ??
                Reflect.getMetadata(auth_decorators_1.REQUIRED_ROLE_KEY, controller));
            return [[name, role ?? OPEN]];
        }));
    };
    it.each([
        ['MessageController', message_controller_1.MessageController, MESSAGE_ROLES],
        ['SessionController', session_controller_1.SessionController, SESSION_ROLES],
    ])('%s carries exactly the roles in its table', (_name, controller, table) => {
        expect(rolesOf(controller)).toEqual(table);
    });
});
// The MCP invoker enforces a tool's requiredRole through hasPermission and nothing else: declaring the tool
// tier 'write' implies no role. A write tool that loses requiredRole is therefore callable over MCP by a
// read-only VIEWER key, so every write tool must declare OPERATOR or higher.
describe('MCP write tools', () => {
    // Handlers are never invoked, so stub services are fine: only the declarations are read.
    const writeTools = (0, tools_1.allAgentTools)({}).filter(tool => tool.tier === 'write');
    it('walks the write tools (a filter that matched none would pass for the wrong reason)', () => {
        // 26 when written: session 4, message 12, contact 2, group 4, label 4.
        expect(writeTools.length).toBeGreaterThanOrEqual(26);
    });
    it('declares requiredRole OPERATOR or higher on every write tool', () => {
        expect(writeTools.filter(tool => !atLeastOperator(tool.requiredRole)).map(tool => tool.name)).toEqual([]);
    });
});
