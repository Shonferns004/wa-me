const { BaileysConnection } = require('./connection');

// Mock baileys
jest.mock('@whiskeysockets/baileys', () => ({
  default: jest.fn(() => ({ ev: { on: jest.fn() } })),
  useMultiFileAuthState: jest.fn(async () => ({ state: {}, saveCreds: jest.fn() })),
  fetchLatestBaileysVersion: jest.fn(async () => ({ version: [1, 2, 3] })),
  DisconnectReason: { loggedOut: 401 },
}));

jest.mock('fs', () => ({
  existsSync: () => true,
  mkdirSync: jest.fn(),
}));

describe('Baileys lifecycle', () => {
  test('connect returns socket', async () => {
    const c = new BaileysConnection('s1', '/tmp/s1', null);
    const sock = await c.connect();
    expect(sock).toBeDefined();
  });

  test('duplicate connect returns same socket', async () => {
    const c = new BaileysConnection('s2', '/tmp/s2', null);
    const s1 = await c.connect();
    const s2 = await c.connect();
    expect(s1).toBe(s2);
  });

  test('disconnect sets status disconnected', async () => {
    const c = new BaileysConnection('s3', '/tmp/s3', null);
    await c.connect();
    await c.disconnect();
    expect(c.getStatus()).toBe('disconnected');
    expect(c.sock).toBeNull();
  });

  test('reconnect after disconnect creates new socket', async () => {
    const c = new BaileysConnection('s4', '/tmp/s4', null);
    await c.connect();
    await c.disconnect();
    const s2 = await c.connect();
    expect(s2).toBeDefined();
  });
});
