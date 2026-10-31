"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const baileys_groups_1 = require("./baileys-groups");
const baileys_contacts_1 = require("./baileys-contacts");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
/**
 * Every group and profile WRITE goes through a Baileys method that awaits `groupQuery`/`query` and
 * then discards the result, so the call resolves the same way whether WhatsApp confirmed the change
 * or never answered — and `query()` catches its own timeout and resolves rather than throwing.
 *
 * There is no value left to inspect, so these pin the only thing that can separate the two: a
 * deadline OpenWA owns. One case per call site, because a missed wrapper is invisible otherwise.
 */
const never = () => new Promise(() => undefined);
const stub = () => jest.fn(never);
function groups(sock, budgetMs) {
    const host = {
        ensureReady: () => undefined,
        sessionProxyUrl: () => undefined,
        getSocket: () => sock,
        logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
        toNeutralJid: (j) => j,
        toEngineJid: (j) => j,
        normalizedSelfJid: () => '628177@s.whatsapp.net',
    };
    return new baileys_groups_1.BaileysGroups(host, budgetMs);
}
function contacts(sock, budgetMs) {
    const host = {
        ensureReady: () => undefined,
        sessionProxyUrl: () => undefined,
        getSocket: () => sock,
        logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
        normalizedSelfJid: () => '628177@s.whatsapp.net',
        listContacts: () => [],
        findContact: () => null,
        resolvePhone: () => null,
        listChats: () => [],
        lastMessage: () => null,
        toEngineJid: (j) => j,
    };
    return new baileys_contacts_1.BaileysContacts(host, budgetMs);
}
// A real 1x1 PNG: a picture write reads the header of its bytes before it reaches the socket.
const PNG = {
    mimetype: 'image/png',
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
};
describe('group writes report an unconfirmed write rather than success', () => {
    it.each([
        ['leaveGroup', 'groupLeave', (g) => g.leaveGroup('123@g.us')],
        ['setGroupSubject', 'groupUpdateSubject', (g) => g.setGroupSubject('123@g.us', 'X')],
        ['setGroupDescription', 'groupUpdateDescription', (g) => g.setGroupDescription('123@g.us', 'X')],
        [
            'setGroupMessagesAdminsOnly',
            'groupSettingUpdate',
            (g) => g.setGroupMessagesAdminsOnly('123@g.us', true),
        ],
        ['setGroupInfoAdminsOnly', 'groupSettingUpdate', (g) => g.setGroupInfoAdminsOnly('123@g.us', true)],
        ['setGroupPicture', 'updateProfilePicture', (g) => g.setGroupPicture('123@g.us', PNG)],
        ['deleteGroupPicture', 'removeProfilePicture', (g) => g.deleteGroupPicture('123@g.us')],
        [
            'setGroupMemberAddMode',
            'groupMemberAddMode',
            (g) => g.setGroupMemberAddMode('123@g.us', 'admins'),
        ],
        ['setGroupEphemeral', 'groupToggleEphemeral', (g) => g.setGroupEphemeral('123@g.us', 604800)],
        // A relayed message rather than an IQ, but the group lookup and device fetch before the relay can stall.
        ['setGroupMemberLabel', 'updateMemberLabel', (g) => g.setGroupMemberLabel('123@g.us', 'Site A')],
    ])('%s', async (_name, sockMethod, call) => {
        await expect(call(groups({ [sockMethod]: stub() }, 15))).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
    });
    it('still resolves when WhatsApp answers inside the budget', async () => {
        const groupLeave = jest.fn().mockResolvedValue(undefined);
        await expect(groups({ groupLeave }, 500).leaveGroup('123@g.us')).resolves.toBeUndefined();
        expect(groupLeave).toHaveBeenCalledWith('123@g.us');
    });
    it('names the operation that was not confirmed', async () => {
        await expect(groups({ groupLeave: stub() }, 15).leaveGroup('123@g.us')).rejects.toThrow('WhatsApp did not confirm leaving the group in time');
    });
});
describe('profile writes report an unconfirmed write rather than success', () => {
    it.each([
        ['setProfileName', 'updateProfileName', (c) => c.setProfileName('Ada')],
        ['setProfileStatus', 'updateProfileStatus', (c) => c.setProfileStatus('busy')],
        ['setProfilePicture', 'updateProfilePicture', (c) => c.setProfilePicture(PNG)],
    ])('%s', async (_name, sockMethod, call) => {
        await expect(call(contacts({ [sockMethod]: stub() }, 15))).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
    });
    it('still resolves when WhatsApp answers inside the budget', async () => {
        const updateProfileName = jest.fn().mockResolvedValue(undefined);
        await expect(contacts({ updateProfileName }, 500).setProfileName('Ada')).resolves.toBeUndefined();
        expect(updateProfileName).toHaveBeenCalledWith('Ada');
    });
});
