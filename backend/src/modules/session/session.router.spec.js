const express = require('express');
const request = require('supertest');
const { createSessionRouter } = require('./session.router');

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function makeApp({ lifecycle, sessionService } = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/sessions',
    createSessionRouter({
      authService: {
        validateApiKey: async (key) => {
          if (key === 'valid-key') return { id: 'key-1', allowedSessions: [] };
          if (key === 'scoped-key') return { id: 'key-2', allowedSessions: ['s1'] };
          return null;
        },
      },
      sessionService: sessionService || { getSessionById: jest.fn(async () => null) },
      lifecycle: lifecycle || {
        listSessions: jest.fn(async () => []),
        createSession: jest.fn(async (data) => ({ id: 'new', ...data })),
        getSession: jest.fn(async () => null),
        deleteSession: jest.fn(async () => false),
        start: jest.fn(async (id) => ({ id, status: 'initializing' })),
        stop: jest.fn(async (id) => ({ id, status: 'disconnected' })),
        logout: jest.fn(async (id) => ({ id, status: 'disconnected', phone: null })),
        forceKill: jest.fn(async (id) => ({ id, status: 'disconnected' })),
        getQRCode: jest.fn(async (id) => ({ qrCode: 'qr', status: 'qr_ready' })),
        requestPairingCode: jest.fn(async () => ({ pairingCode: 'ABCD-1234', status: 'created' })),
        decorate: (session) => ({ ...session, engineLoaded: false }),
      },
    }),
  );
  // Mirrors app.js so lifecycle refusals keep their status and machine-readable code.
  app.use((err, req, res, next) => {
    const body = { message: err.message || 'Internal Server Error' };
    if (err.code) body.code = err.code;
    res.status(err.status || 500).json(body);
  });
  return app;
}

const withKey = (agent) => agent.set('x-api-key', 'valid-key');

describe('session router auth', () => {
  test('rejects a request without an API key', async () => {
    const res = await request(makeApp()).get('/sessions');
    expect(res.status).toBe(401);
  });

  test('rejects an unknown API key', async () => {
    const res = await request(makeApp()).get('/sessions').set('x-api-key', 'nope');
    expect(res.status).toBe(401);
  });
});

describe('session router allowedSessions scope', () => {
  test('passes the key scope to the list query', async () => {
    const lifecycle = { listSessions: jest.fn(async () => []), decorate: (s) => s };
    const res = await request(makeApp({ lifecycle }))
      .get('/sessions')
      .set('x-api-key', 'scoped-key');
    expect(res.status).toBe(200);
    expect(lifecycle.listSessions).toHaveBeenCalledWith(['s1']);
  });

  test('an unrestricted key passes an empty scope', async () => {
    const lifecycle = { listSessions: jest.fn(async () => []), decorate: (s) => s };
    await withKey(request(makeApp({ lifecycle })).get('/sessions'));
    expect(lifecycle.listSessions).toHaveBeenCalledWith([]);
  });

  test('refuses a scoped key on a different session id', async () => {
    const lifecycle = { getSession: jest.fn(async () => ({ id: 's2' })), decorate: (s) => s };
    const res = await request(makeApp({ lifecycle }))
      .get('/sessions/s2')
      .set('x-api-key', 'scoped-key');
    expect(res.status).toBe(403);
    expect(lifecycle.getSession).not.toHaveBeenCalled();
  });

  test('refuses a scoped key on lifecycle verbs for another session', async () => {
    const lifecycle = { start: jest.fn(async (id) => ({ id })), decorate: (s) => s };
    const res = await request(makeApp({ lifecycle }))
      .post('/sessions/s2/start')
      .set('x-api-key', 'scoped-key');
    expect(res.status).toBe(403);
    expect(lifecycle.start).not.toHaveBeenCalled();
  });

  test('allows a scoped key on its own session', async () => {
    const lifecycle = { getSession: jest.fn(async () => ({ id: 's1' })), decorate: (s) => s };
    const res = await request(makeApp({ lifecycle }))
      .get('/sessions/s1')
      .set('x-api-key', 'scoped-key');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('s1');
  });
});

describe('session router CRUD', () => {
  test('lists decorated sessions', async () => {
    const lifecycle = {
      listSessions: jest.fn(async () => [{ id: 's1', engineLoaded: true, lastError: null }]),
      decorate: (session) => session,
    };
    const res = await withKey(request(makeApp({ lifecycle })).get('/sessions'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 's1', engineLoaded: true, lastError: null }]);
  });

  test('creates a session with 201', async () => {
    const lifecycle = {
      createSession: jest.fn(async (data) => ({ id: 'new', ...data })),
      decorate: (session) => session,
    };
    const res = await withKey(request(makeApp({ lifecycle })).post('/sessions')).send({ name: 'n' });
    expect(res.status).toBe(201);
    expect(lifecycle.createSession).toHaveBeenCalledWith({ name: 'n' });
  });

  test('returns 404 for a missing session', async () => {
    const lifecycle = { getSession: jest.fn(async () => null), decorate: (s) => s };
    const res = await withKey(request(makeApp({ lifecycle })).get('/sessions/missing'));
    expect(res.status).toBe(404);
  });

  test('deletes an existing session with 204', async () => {
    const lifecycle = { deleteSession: jest.fn(async () => true) };
    const res = await withKey(request(makeApp({ lifecycle })).delete('/sessions/s1'));
    expect(res.status).toBe(204);
  });

  test('returns 404 when deleting a missing session', async () => {
    const lifecycle = { deleteSession: jest.fn(async () => false) };
    const res = await withKey(request(makeApp({ lifecycle })).delete('/sessions/missing'));
    expect(res.status).toBe(404);
  });

  test('projects config and proxy from the stored row', async () => {
    const sessionService = {
      getSessionById: jest.fn(async () => ({
        id: 's1',
        config: { a: 1 },
        proxyUrl: 'http://proxy',
        proxyType: 'http',
      })),
    };
    const app = makeApp({ sessionService });
    const config = await withKey(request(app).get('/sessions/s1/config'));
    const proxy = await withKey(request(app).get('/sessions/s1/proxy'));
    expect(config.status).toBe(200);
    expect(config.body).toEqual({ a: 1 });
    expect(proxy.body).toEqual({ proxyUrl: 'http://proxy', proxyType: 'http' });
  });
});

describe('session router lifecycle', () => {
  test('delegates start and returns the decorated session', async () => {
    const lifecycle = {
      start: jest.fn(async (id) => ({ id, status: 'initializing' })),
      decorate: (session) => ({ ...session, engineLoaded: true }),
    };
    const res = await withKey(request(makeApp({ lifecycle })).post('/sessions/s1/start'));
    expect(res.status).toBe(200);
    expect(lifecycle.start).toHaveBeenCalledWith('s1');
    expect(res.body).toEqual({ id: 's1', status: 'initializing', engineLoaded: true });
  });

  test('delegates stop, logout and force-kill', async () => {
    const lifecycle = {
      stop: jest.fn(async (id) => ({ id, status: 'disconnected' })),
      logout: jest.fn(async (id) => ({ id, status: 'disconnected', phone: null })),
      forceKill: jest.fn(async (id) => ({ id, status: 'disconnected' })),
      decorate: (session) => session,
    };
    const app = makeApp({ lifecycle });
    expect((await withKey(request(app).post('/sessions/s1/stop'))).status).toBe(200);
    expect((await withKey(request(app).post('/sessions/s1/logout'))).status).toBe(200);
    expect((await withKey(request(app).post('/sessions/s1/force-kill'))).status).toBe(200);
    expect(lifecycle.stop).toHaveBeenCalledWith('s1');
    expect(lifecycle.logout).toHaveBeenCalledWith('s1');
    expect(lifecycle.forceKill).toHaveBeenCalledWith('s1');
  });

  test('returns the QR payload', async () => {
    const res = await withKey(request(makeApp()).get('/sessions/s1/qr'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ qrCode: 'qr', status: 'qr_ready' });
  });

  test('creates a pairing code with 201', async () => {
    const lifecycle = {
      requestPairingCode: jest.fn(async () => ({ pairingCode: 'ABCD-1234', status: 'created' })),
    };
    const res = await withKey(request(makeApp({ lifecycle })).post('/sessions/s1/pairing-code')).send({
      phoneNumber: '628123',
    });
    expect(res.status).toBe(201);
    expect(lifecycle.requestPairingCode).toHaveBeenCalledWith('s1', '628123');
  });

  test('preserves the status and code of a partial teardown', async () => {
    const lifecycle = {
      stop: jest.fn(async () => {
        throw httpError(502, 'teardown incomplete', 'SESSION_STOP_INCOMPLETE');
      }),
    };
    const res = await withKey(request(makeApp({ lifecycle })).post('/sessions/s1/stop'));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ message: 'teardown incomplete', code: 'SESSION_STOP_INCOMPLETE' });
  });
});
