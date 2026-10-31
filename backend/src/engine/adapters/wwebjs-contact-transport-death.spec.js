"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wwebjs_contacts_1 = require("./wwebjs-contacts");
const logger_service_1 = require("../../common/services/logger.service");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
/**
 * Six contact operations reported a dead page and then rethrew the raw Puppeteer error, so the
 * caller got HTTP 500 while every one of those routes documents 503 (contact.controller.ts:78,
 * :117, :182, :207, :230, :252). A user hit it on GET /contacts/blocked when the renderer crashed
 * mid-read: the route promises "retry shortly" and answered the one status that says the opposite.
 *
 * The sibling reads in the same file (getContacts, getContactById, getProfilePicture) already made
 * the split, which is why the file answered two different statuses for one kind of failure.
 */
const logger = (0, logger_service_1.createLogger)('wwebjs-contact-transport-death.spec');
describe('contact operations distinguish a dead page from an ordinary failure', () => {
    const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
    function makeContacts(reject) {
        const contact = {
            block: jest.fn().mockRejectedValue(reject),
            unblock: jest.fn().mockRejectedValue(reject),
        };
        const client = {
            getNumberId: jest.fn().mockRejectedValue(reject),
            getBlockedContacts: jest.fn().mockRejectedValue(reject),
            saveOrEditAddressbookContact: jest.fn().mockRejectedValue(reject),
            deleteAddressbookContact: jest.fn().mockRejectedValue(reject),
            getContactById: jest.fn().mockResolvedValue(contact),
        };
        const reportIfPageTransportError = jest.fn();
        const host = {
            ensureReady: jest.fn(),
            getClient: () => client,
            isPageTransportError: (error) => error === transportError,
            reportIfPageTransportError,
            logger,
        };
        return { contacts: new wwebjs_contacts_1.WwebjsContacts(host), reportIfPageTransportError };
    }
    const call = (contacts, op) => ({
        getNumberId: () => contacts.getNumberId('628123'),
        getBlockedContacts: () => contacts.getBlockedContacts(),
        upsertContact: () => contacts.upsertContact('628123@c.us', 'Ada'),
        deleteContact: () => contacts.deleteContact('628123@c.us'),
        blockContact: () => contacts.blockContact('628123@c.us'),
        unblockContact: () => contacts.unblockContact('628123@c.us'),
    })[op]();
    const OPS = ['getNumberId', 'getBlockedContacts', 'upsertContact', 'deleteContact', 'blockContact', 'unblockContact'];
    it.each(OPS)('%s answers a dead page with the 503 its route documents', async (op) => {
        const { contacts, reportIfPageTransportError } = makeContacts(transportError);
        await expect(call(contacts, op)).rejects.toThrow(engine_transport_error_1.EngineTransportError);
        expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
    });
    // Negative twin: an ordinary page-side failure must still surface untouched. Without this the fix
    // could simply relabel every failure as a 503, which would tell a caller to retry a request that
    // WhatsApp genuinely refused.
    it.each(OPS)('%s still propagates an ordinary failure unchanged', async (op) => {
        const refusal = new Error('Evaluation failed: contact not found');
        const { contacts, reportIfPageTransportError } = makeContacts(refusal);
        await expect(call(contacts, op)).rejects.toBe(refusal);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
});
