jest.mock('../../database', () => {
  const store = new Map();
  store.set('exists', { id: 'exists', name: 's', status: 'created', config: { a: 1 }, proxyUrl: 'http://p', proxyType: 'http' });
  return {
    getDb: () => ({
      getRepository: (name) => {
        if (name === 'Session') {
          return {
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
          };
        }
        if (name === 'ApiKey') {
          return {
            findOne: async ({ where }) => {
              const map = {
                'hash-valid': { isActive: true, allowedSessions: ['exists'] },
                'hash-all': { isActive: true, allowedSessions: [] },
              };
              return map[where.keyHash] || null;
            },
          };
        }
        return {};
      },
    }),
  };
});

jest.mock('../../modules/auth/api-key-hash', () => ({
  hashApiKey: (raw) => {
    if (raw === 'valid-key') return 'hash-valid';
    if (raw === 'all-key') return 'hash-all';
    return 'hash-unknown';
  },
}));

const request = require('supertest');
const { createApp } = require('../../app');

describe('Session HTTP CRUD', () => {
  const app = createApp();
  test('missing api key -> 401', async () => {
    const res = await request(app).get('/sessions');
    expect(res.status).toBe(401);
  });
  test('invalid api key -> 401', async () => {
    const res = await request(app).get('/sessions').set('x-api-key', 'bad');
    expect(res.status).toBe(401);
  });
  test('list sessions valid', async () => {
    const res = await request(app).get('/sessions').set('x-api-key', 'valid-key');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
  test('get existing', async () => {
    const res = await request(app).get('/sessions/exists').set('x-api-key', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('exists');
  });
  test('get missing -> 404', async () => {
    const res = await request(app).get('/sessions/nope').set('x-api-key', 'all-key');
    expect(res.status).toBe(404);
  });
  test('scoped key cannot read another session -> 403', async () => {
    const res = await request(app).get('/sessions/nope').set('x-api-key', 'valid-key');
    expect(res.status).toBe(403);
  });
  test('create session', async () => {
    const res = await request(app).post('/sessions').set('x-api-key', 'valid-key').send({ id: 'new1', name: 'n1' });
    expect(res.status).toBe(201);
  });
  test('duplicate create', async () => {
    const res = await request(app).post('/sessions').set('x-api-key', 'valid-key').send({ id: 'dup', name: 's' });
    expect(res.status).toBe(409);
  });
  test('delete existing', async () => {
    const res = await request(app).delete('/sessions/new1').set('x-api-key', 'all-key');
    expect(res.status).toBe(204);
  });
  test('delete missing -> 404', async () => {
    const res = await request(app).delete('/sessions/nope').set('x-api-key', 'all-key');
    expect(res.status).toBe(404);
  });
  test('update missing -> 404/405', async () => {
    const res = await request(app).put('/sessions/nope').set('x-api-key', 'valid-key').send({ status: 'ready' });
    expect([404, 405]).toContain(res.status);
  });
  test('config existing', async () => {
    const res = await request(app).get('/sessions/exists/config').set('x-api-key', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.body.a).toBe(1);
  });
  test('config missing -> 404', async () => {
    const res = await request(app).get('/sessions/nope/config').set('x-api-key', 'all-key');
    expect(res.status).toBe(404);
  });
  test('proxy existing', async () => {
    const res = await request(app).get('/sessions/exists/proxy').set('x-api-key', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.body.proxyUrl).toBe('http://p');
  });
  test('proxy missing -> 404', async () => {
    const res = await request(app).get('/sessions/nope/proxy').set('x-api-key', 'all-key');
    expect(res.status).toBe(404);
  });
  test('list is scoped to the key allowedSessions', async () => {
    const res = await request(app).get('/sessions').set('x-api-key', 'valid-key');
    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.id)).toEqual(['exists']);
  });
  test('unrestricted key lists every session', async () => {
    await request(app).post('/sessions').set('x-api-key', 'all-key').send({ id: 'other', name: 'other' });
    const res = await request(app).get('/sessions').set('x-api-key', 'all-key');
    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.id).sort()).toEqual(['exists', 'other']);
  });
});
