jest.mock('../../database', () => ({
  getDb: () => ({
    getRepository: () => ({
      findOne: async ({ where }) => {
        const map = {
          'hash-valid': { isActive: true, allowedSessions: ['session-a'] },
          'hash-empty': { isActive: true, allowedSessions: [] },
          'hash-null': { isActive: true, allowedSessions: null },
          'hash-disabled': { isActive: false, allowedSessions: [] },
        };
        return map[where.keyHash] || null;
      },
    }),
  }),
}));

jest.mock('./api-key-hash', () => ({
  hashApiKey: (raw) => {
    if (raw === 'valid-key') return 'hash-valid';
    if (raw === 'empty-key') return 'hash-empty';
    if (raw === 'null-key') return 'hash-null';
    if (raw === 'disabled-key') return 'hash-disabled';
    return 'hash-unknown';
  },
}));

const { AuthService } = require('./auth.express.service');

describe('AuthService', () => {
  const svc = new AuthService();
  test('valid key', async () => {
    const k = await svc.validateApiKey('valid-key');
    expect(k).not.toBeNull();
  });
  test('invalid key', async () => {
    const k = await svc.validateApiKey('nope');
    expect(k).toBeNull();
  });
  test('disabled key', async () => {
    const k = await svc.validateApiKey('disabled-key');
    expect(k).toBeNull();
  });
  test('missing key', async () => {
    const k = await svc.validateApiKey(null);
    expect(k).toBeNull();
  });
  test('authorize allowed', async () => {
    const r = await svc.authorizeSession('valid-key', 'session-a');
    expect(r.ok).toBe(true);
  });
  test('authorize forbidden', async () => {
    const r = await svc.authorizeSession('valid-key', 'session-b');
    expect(r.ok).toBe(false);
  });
  test('empty allowedSessions unrestricted', async () => {
    const r = await svc.authorizeSession('empty-key', 'any');
    expect(r.ok).toBe(true);
  });
  test('null allowedSessions unrestricted', async () => {
    const r = await svc.authorizeSession('null-key', 'any');
    expect(r.ok).toBe(true);
  });
  test('unknown session invalid id', async () => {
    const r = await svc.authorizeSession('valid-key', '');
    expect(r.ok).toBe(false);
  });
});
