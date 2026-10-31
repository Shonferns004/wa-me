const path = require('path');

jest.mock('fs/promises', () => ({ rm: jest.fn(async () => {}) }));
jest.mock('../../common/utils/private-dir.util', () => ({ ensurePrivateDir: jest.fn() }));
jest.mock('../../engine/builtin/whatsapp-web-js', () => ({
  WhatsAppWebJsPlugin: jest.fn(function (config) {
    this.config = config;
    this.createEngine = jest.fn((options) => ({ engine: 'wwjs', config, options }));
  }),
}));
jest.mock('../../engine/builtin/baileys', () => ({
  BaileysPlugin: jest.fn(function () {
    this.createEngine = jest.fn((options) => ({ engine: 'baileys', options }));
  }),
}));

const fs = require('fs/promises');
const { ensurePrivateDir } = require('../../common/utils/private-dir.util');
const { WhatsAppWebJsPlugin } = require('../../engine/builtin/whatsapp-web-js');
const { BaileysPlugin } = require('../../engine/builtin/baileys');
const { SessionEngineProvider } = require('./session-engine.provider');

const SESSION_DATA_PATH = './data/sessions';
const BAILEYS_AUTH_DIR = './data/baileys';

function makeProvider(overrides = {}) {
  return new SessionEngineProvider({
    config: {
      engine: {
        type: 'whatsapp-web.js',
        sessionDataPath: SESSION_DATA_PATH,
        baileys: { authDir: BAILEYS_AUTH_DIR },
        ...overrides,
      },
    },
  });
}

const wwjsDir = (id) => path.join(path.resolve(SESSION_DATA_PATH), `session-${id}`);
const baileysDir = (id) => path.join(BAILEYS_AUTH_DIR, id);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SessionEngineProvider.createEngine', () => {
  test('builds a whatsapp-web.js engine with the session fields', () => {
    const provider = makeProvider();
    const engine = provider.createEngine({
      sessionId: 'abc',
      dbSessionId: 'db-abc',
      proxyUrl: 'http://proxy:8080',
      proxyType: 'http',
    });

    const plugin = WhatsAppWebJsPlugin.mock.instances[0];
    expect(plugin.createEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'abc',
        dbSessionId: 'db-abc',
        proxyUrl: 'http://proxy:8080',
        proxyType: 'http',
        sessionDataPath: SESSION_DATA_PATH,
        authDir: BAILEYS_AUTH_DIR,
      }),
    );
    expect(engine.engine).toBe('wwjs');
  });

  test('hardens both credential directories before handing off to the plugin', () => {
    const provider = makeProvider();
    provider.createEngine({ sessionId: 'abc' });

    expect(ensurePrivateDir).toHaveBeenCalledWith(wwjsDir('abc'));
    expect(ensurePrivateDir).toHaveBeenCalledWith(baileysDir('abc'));
  });

  test('builds a baileys engine when configured', () => {
    const provider = makeProvider({ type: 'baileys' });
    const engine = provider.createEngine({ sessionId: 'abc' });

    expect(BaileysPlugin).toHaveBeenCalledTimes(1);
    expect(engine.engine).toBe('baileys');
  });

  test('rejects an unsafe session id before touching the filesystem', () => {
    const provider = makeProvider();
    expect(() => provider.createEngine({ sessionId: '../escape' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(ensurePrivateDir).not.toHaveBeenCalled();
  });

  test('rejects an unknown engine type', () => {
    const provider = makeProvider({ type: 'carrier-pigeon' });
    expect(() => provider.createEngine({ sessionId: 'abc' })).toThrow(/Unknown ENGINE_TYPE/);
  });
});

describe('SessionEngineProvider.purgeSessionData', () => {
  test('removes both engines credential dirs for the row id', async () => {
    const provider = makeProvider();
    await provider.purgeSessionData('abc');

    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(fs.rm).toHaveBeenCalledWith(wwjsDir('abc'), { recursive: true, force: true });
    expect(fs.rm).toHaveBeenCalledWith(baileysDir('abc'), { recursive: true, force: true });
  });

  test('also purges legacy name dirs when the name differs from the id', async () => {
    const provider = makeProvider();
    await provider.purgeSessionData('abc', 'legacy');

    expect(fs.rm).toHaveBeenCalledWith(wwjsDir('legacy'), { recursive: true, force: true });
    expect(fs.rm).toHaveBeenCalledWith(baileysDir('legacy'), { recursive: true, force: true });
  });

  test('skips a legacy name that is not a safe path segment', async () => {
    const provider = makeProvider();
    await provider.purgeSessionData('abc', '../escape');

    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(fs.rm).not.toHaveBeenCalledWith(
      expect.stringContaining('escape'),
      expect.anything(),
    );
  });

  test('rejects an unsafe row id', async () => {
    const provider = makeProvider();
    await expect(provider.purgeSessionData('../escape')).rejects.toMatchObject({ status: 400 });
    expect(fs.rm).not.toHaveBeenCalled();
  });
});
