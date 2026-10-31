"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wwebjs_contacts_1 = require("./wwebjs-contacts");
const baileys_contacts_1 = require("./baileys-contacts");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * The blocklist READ — the missing half of the exposed block/unblock writes. The neutral shape is
 * a bare array of ids: whatsapp-web.js resolves full Contact models but Baileys' blocklist query
 * answers only jids, and inventing the other fields on one engine would make the two engines claim
 * different things about the same account.
 */
const logger = (0, logger_service_1.createLogger)('blocked-contacts.spec');
describe('WwebjsContacts.getBlockedContacts', () => {
    function makeContacts() {
        const client = { getBlockedContacts: jest.fn() };
        const host = {
            ensureReady: jest.fn(),
            getClient: () => client,
            logger,
            reportIfPageTransportError: jest.fn(),
        };
        return { contacts: new wwebjs_contacts_1.WwebjsContacts(host), client };
    }
    it('maps the blocked Contact models to their neutral ids', async () => {
        const { contacts, client } = makeContacts();
        client.getBlockedContacts.mockResolvedValue([
            { id: { _serialized: '628111@c.us' } },
            { id: { _serialized: '628222@c.us' } },
        ]);
        await expect(contacts.getBlockedContacts()).resolves.toEqual(['628111@c.us', '628222@c.us']);
    });
    it('drops an entry whose id is unreadable rather than reporting "undefined"', async () => {
        const { contacts, client } = makeContacts();
        client.getBlockedContacts.mockResolvedValue([{ id: {} }, { id: { _serialized: '628333@c.us' } }]);
        await expect(contacts.getBlockedContacts()).resolves.toEqual(['628333@c.us']);
    });
    it('lists an id once when the blocklist holds a contact under both its LID and its phone', async () => {
        const { contacts, client } = makeContacts();
        // whatsapp-web.js answers a LID entry under the contact's phone id (a plain string), so the two
        // entries read as the same id.
        client.getBlockedContacts.mockResolvedValue([
            { id: '628111@c.us' },
            { id: { _serialized: '628222@c.us' } },
            { id: { _serialized: '628111@c.us' } },
        ]);
        await expect(contacts.getBlockedContacts()).resolves.toEqual(['628111@c.us', '628222@c.us']);
    });
    it('resolves [] for an empty blocklist', async () => {
        const { contacts, client } = makeContacts();
        client.getBlockedContacts.mockResolvedValue([]);
        await expect(contacts.getBlockedContacts()).resolves.toEqual([]);
    });
});
describe('BaileysContacts.getBlockedContacts', () => {
    function makeContacts(toNeutralJid = (jid) => jid.replace('@s.whatsapp.net', '@c.us')) {
        const sock = { fetchBlocklist: jest.fn() };
        const host = {
            ensureReady: jest.fn(),
            getSocket: () => sock,
            logger,
            toNeutralJid,
        };
        return { contacts: new baileys_contacts_1.BaileysContacts(host), sock };
    }
    it('neutralises the blocklist jids', async () => {
        const { contacts, sock } = makeContacts();
        sock.fetchBlocklist.mockResolvedValue(['628111@s.whatsapp.net', '628222@s.whatsapp.net']);
        await expect(contacts.getBlockedContacts()).resolves.toEqual(['628111@c.us', '628222@c.us']);
    });
    it('drops undefined jid attrs (a wire item without a jid carries nothing addressable)', async () => {
        const { contacts, sock } = makeContacts();
        sock.fetchBlocklist.mockResolvedValue([undefined, '628333@s.whatsapp.net']);
        await expect(contacts.getBlockedContacts()).resolves.toEqual(['628333@c.us']);
    });
    it('lists an id once when the blocklist holds a contact under both its LID and its phone', async () => {
        // The session knows the pair, so both wire jids fold to the contact's phone id.
        const { contacts, sock } = makeContacts(jid => jid === '111222333@lid' ? '628111@c.us' : jid.replace('@s.whatsapp.net', '@c.us'));
        sock.fetchBlocklist.mockResolvedValue(['111222333@lid', '628111@s.whatsapp.net', '628999@s.whatsapp.net']);
        await expect(contacts.getBlockedContacts()).resolves.toEqual(['628111@c.us', '628999@c.us']);
    });
    it('resolves [] for an empty blocklist', async () => {
        const { contacts, sock } = makeContacts();
        sock.fetchBlocklist.mockResolvedValue([]);
        await expect(contacts.getBlockedContacts()).resolves.toEqual([]);
    });
});
