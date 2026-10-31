const { authorizeSocketJoin } = require('./authorization');

// Mock database module
jest.mock('../database', () => ({
  getDb: () => ({
    getRepository: () => ({
      findOne: async ({ where }) => {
        // simple fixture map
        const keys = {
          'hash-valid': { isActive: true, allowedSessions: ['session-a'] },
          'hash-empty': { isActive: true, allowedSessions: [] },
          'hash-null': { isActive: true, allowedSessions: null },
          'hash-disabled': { isActive: false, allowedSessions: [] },
        };
        return keys[where.keyHash] || null;
      },
    }),
  }),
}));

// Mock hashApiKey to identity-ish
jest.mock('../modules/auth/api-key-hash', () => ({
  hashApiKey: (raw) => {
    if (raw === 'valid-key') return 'hash-valid';
    if (raw === 'empty-key') return 'hash-empty';
    if (raw === 'null-key') return 'hash-null';
    if (raw === 'disabled-key') return 'hash-disabled';
    return 'hash-unknown';
  },
}));

describe('authorizeSocketJoin', () => {
  test('valid key + authorized session', async () => {
    const r = await authorizeSocketJoin('session-a', 'valid-key');
    expect(r.ok).toBe(true);
  });
  test('valid key + unauthorized session', async () => {
    const r = await authorizeSocketJoin('session-b', 'valid-key');
    expect(r.ok).toBe(false);
  });
  test('empty allowedSessions => unrestricted', async () => {
    const r = await authorizeSocketJoin('session-x', 'empty-key');
    expect(r.ok).toBe(true);
  });
  test('null allowedSessions => unrestricted', async () => {
    const r = await authorizeSocketJoin('session-x', 'null-key');
    expect(r.ok).toBe(true);
  });
  test('disabled key rejected', async () => {
    const r = await authorizeSocketJoin('session-a', 'disabled-key');
    expect(r.ok).toBe(false);
  });
  test('unknown key rejected', async () => {
    const r = await authorizeSocketJoin('session-a', 'nope');
    expect(r.ok).toBe(false);
  });
  test('missing key rejected', async () => {
    const r = await authorizeSocketJoin('session-a', null);
    expect(r.ok).toBe(false);
  });
  test('invalid sessionId rejected', async () => {
    const r = await authorizeSocketJoin('', 'valid-key');
    expect(r.ok).toBe(false);
  });
});
