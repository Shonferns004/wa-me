"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const wwebjs_chats_1 = require("./wwebjs-chats");
const wwebjs_contacts_1 = require("./wwebjs-contacts");
const wwebjs_groups_1 = require("./wwebjs-groups");
const wwebjs_labels_1 = require("./wwebjs-labels");
const wwebjs_host_1 = require("./wwebjs-host");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const logger_service_1 = require("../../common/services/logger.service");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
/**
 * A call already in flight when WhatsApp Web reloads its page dies with Puppeteer's navigation error before
 * the re-inject window is stamped, so it was a bare 500, and where a catch folds a failed lookup into "not
 * found" it was a 404 or null for a group, contact or label that exists. The page is alive: nothing is
 * reported, and the answer is the retryable 409 the adapter already gives inside the window.
 */
const logger = (0, logger_service_1.createLogger)('wwebjs-navigation-error.spec');
const NAVIGATION = 'Execution context was destroyed, most likely because of a navigation.';
describe('isNavigationError', () => {
    it.each([
        NAVIGATION,
        'Evaluation failed: TypeError: window.require is not a function',
        'execution context was destroyed',
    ])('reads %p as a navigation', message => {
        expect((0, wwebjs_lifecycle_1.isNavigationError)(new Error(message))).toBe(true);
    });
    it('is not a dead page, so the death path never sees it', () => {
        const pattern = wwebjs_lifecycle_1.WwebjsLifecycle
            .PAGE_TRANSPORT_ERROR_PATTERN;
        expect(pattern.test(NAVIGATION)).toBe(false);
    });
    it.each([
        'Protocol error (Runtime.callFunctionOn): Target closed',
        "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls",
        'Evaluation failed: TypeError: Cannot read properties of null',
        '',
    ])('does not read %p as a navigation', message => {
        expect((0, wwebjs_lifecycle_1.isNavigationError)(new Error(message))).toBe(false);
    });
    it('does not take the words from an error this application built', () => {
        // MessageNotFoundError and its siblings carry the caller's own text, so a request could name its way in.
        expect((0, wwebjs_lifecycle_1.isNavigationError)(new common_1.NotFoundException(`Message ${NAVIGATION} not found in chat 1@c.us`))).toBe(false);
    });
    it('does not take the words from a failure captured inside the page', () => {
        expect((0, wwebjs_lifecycle_1.isNavigationError)(new Error(`${wwebjs_lifecycle_1.CAPTURED_PAGE_ERROR_PREFIX}{"message":"${NAVIGATION}"}`))).toBe(false);
    });
});
describe('a call the page navigation cut short', () => {
    const navigation = new Error(NAVIGATION);
    const ordinary = new Error('Evaluation failed: something else');
    function makeHost(client) {
        const reportIfPageTransportError = jest.fn();
        const host = {
            ensureReady: jest.fn(),
            getClient: () => client,
            isPageTransportError: () => false,
            reportIfPageTransportError,
            logger,
            config: {},
        };
        return { host, reportIfPageTransportError };
    }
    const reload = () => expect.objectContaining({ message: wwebjs_lifecycle_1.PAGE_RELOADING_MESSAGE });
    it('withPage answers the 409 and reports nothing', async () => {
        const { host, reportIfPageTransportError } = makeHost({});
        const result = (0, wwebjs_host_1.withPage)(host, 'getNumberId', () => Promise.reject(navigation));
        await expect(result).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        await expect(result).rejects.toEqual(reload());
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
    it('a page the host reads as dead stays a death, whatever the message says', async () => {
        const { host, reportIfPageTransportError } = makeHost({});
        host.isPageTransportError = () => true;
        await expect((0, wwebjs_host_1.withPage)(host, 'getNumberId', () => Promise.reject(navigation))).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
        expect(reportIfPageTransportError).toHaveBeenCalledWith(navigation, 'getNumberId');
    });
    it('withPage still propagates an ordinary failure unchanged', async () => {
        const { host } = makeHost({});
        await expect((0, wwebjs_host_1.withPage)(host, 'getNumberId', () => Promise.reject(ordinary))).rejects.toBe(ordinary);
    });
    it('the chat and group lists answer the 409', async () => {
        const client = { info: {}, pupPage: { evaluate: jest.fn().mockRejectedValue(navigation) } };
        const { host, reportIfPageTransportError } = makeHost(client);
        await expect(new wwebjs_chats_1.WwebjsChats(host, {}).getChats()).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        await expect(new wwebjs_groups_1.WwebjsGroups(host).getGroups()).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
    it('a group read is not "group not found"', async () => {
        const getChatById = jest.fn().mockRejectedValue(navigation);
        const { host } = makeHost({ info: {}, getChatById });
        await expect(new wwebjs_groups_1.WwebjsGroups(host).getGroupInfo('1@g.us')).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        getChatById.mockRejectedValue(ordinary);
        await expect(new wwebjs_groups_1.WwebjsGroups(host).getGroupInfo('1@g.us')).resolves.toBeNull();
    });
    it('an invite preview is not "no such invite"', async () => {
        const getInviteInfo = jest.fn().mockRejectedValue(navigation);
        const { host } = makeHost({ getInviteInfo });
        await expect(new wwebjs_groups_1.WwebjsGroups(host).getGroupJoinInfo('code')).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
    });
    it('an invite acceptance answers the unknown-outcome 503, not an invalid invite', async () => {
        const acceptInvite = jest.fn().mockRejectedValue(navigation);
        const { host } = makeHost({ acceptInvite });
        await expect(new wwebjs_groups_1.WwebjsGroups(host).joinGroupViaInviteCode('code')).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
    });
    it('a contact read is not "no such contact"', async () => {
        const getContactById = jest.fn().mockRejectedValue(navigation);
        const { host } = makeHost({ getContactById });
        await expect(new wwebjs_contacts_1.WwebjsContacts(host).getContactById('1@c.us')).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        getContactById.mockRejectedValue(ordinary);
        await expect(new wwebjs_contacts_1.WwebjsContacts(host).getContactById('1@c.us')).resolves.toBeNull();
    });
    it('the contact list, the avatar and the number lookup answer the 409', async () => {
        const getProfilePicUrl = jest.fn().mockRejectedValue(navigation);
        const getNumberId = jest.fn().mockRejectedValue(navigation);
        const client = {
            info: {},
            pupPage: { evaluate: jest.fn().mockRejectedValue(navigation) },
            getProfilePicUrl,
            getNumberId,
        };
        const { host, reportIfPageTransportError } = makeHost(client);
        const contacts = new wwebjs_contacts_1.WwebjsContacts(host);
        await expect(contacts.getContacts()).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        await expect(contacts.getProfilePicture('1@c.us')).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        await expect(contacts.getNumberId('628123')).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
    it('a chat write answers the 409', async () => {
        const getChatById = jest.fn().mockRejectedValue(navigation);
        const { host } = makeHost({ getChatById });
        await expect(new wwebjs_chats_1.WwebjsChats(host, {}).muteChat('1@c.us', null)).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
    });
    it('a label read is not "no such label"', async () => {
        const getChatsByLabelId = jest.fn().mockRejectedValue(navigation);
        const { host } = makeHost({ getChatsByLabelId });
        await expect(new wwebjs_labels_1.WwebjsLabels(host).getChatsByLabel('7')).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
    });
});
