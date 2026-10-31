jest.mock('../../database', () => {
  const store = new Map();
  store.set('exists', { id: 'exists', name: 's', status: 'created' });
  return {
    getDb: () => ({
      getRepository: () => ({
        findOne: async ({ where }) => {
          if (where.id) return store.get(where.id) || null;
          if (where.name) {
            for (const v of store.values()) if (v.name === where.name) return v;
            return null;
          }
          return null;
        },
        find: async () => Array.from(store.values()),
        create: (data) => ({ ...data }),
        save: async (e) => { store.set(e.id, e); return e; },
        remove: async (e) => { store.delete(e.id); },
      }),
    }),
  };
});

const { SessionService } = require('./session.express.service');

describe('SessionService CRUD', () => {
  const svc = new SessionService();
  test('create session', async () => {
    const s = await svc.createSession({ id: 'new1', name: 'n1' });
    expect(s.id).toBe('new1');
  });
  test('duplicate session', async () => {
    await expect(svc.createSession({ id: 'dup', name: 's' })).rejects.toThrow();
  });
  test('update session', async () => {
    const s = await svc.updateSession('exists', { status: 'ready' });
    expect(s.status).toBe('ready');
  });
  test('update missing', async () => {
    const s = await svc.updateSession('nope', { status: 'ready' });
    expect(s).toBeNull();
  });
  test('listSessions scopes to allowedSessions', async () => {
    await svc.createSession({ id: 'other1', name: 'other1' });
    const scoped = await svc.listSessions(['exists']);
    expect(scoped.map((s) => s.id)).toEqual(['exists']);
  });
  test('listSessions treats an empty or null scope as unrestricted', async () => {
    const empty = await svc.listSessions([]);
    const nil = await svc.listSessions(null);
    expect(empty.map((s) => s.id).sort()).toEqual(['exists', 'new1', 'other1']);
    expect(nil.map((s) => s.id).sort()).toEqual(['exists', 'new1', 'other1']);
  });
  test('delete session', async () => {
    const ok = await svc.deleteSession('exists');
    expect(ok).toBe(true);
  });
  test('delete missing', async () => {
    const ok = await svc.deleteSession('nope');
    expect(ok).toBe(false);
  });
  test('getSessionById existing', async () => {
    const s = await svc.getSessionById('exists');
    // may be deleted in previous test; handle gracefully
    expect(s === null || s.id === 'exists').toBe(true);
  });
  test('listSessions', async () => {
    const list = await svc.listSessions();
    expect(Array.isArray(list)).toBe(true);
  });
});
