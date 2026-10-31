const { EngineRegistry } = require('../../engine/engine-registry.service');
const { resolveEngineInitTimeoutMs } = require('../../engine/engine-init-timeout');
const { SessionLifecycleService, resolveMaxConcurrentSessions } = require('./session-lifecycle.service');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeSessionService(initial = {}) {
  const rows = new Map(
    Object.entries(initial).map(([id, session]) => [id, { id, status: 'created', ...session }]),
  );
  return {
    rows,
    getSessionById: jest.fn(async (id) => rows.get(id) ?? null),
    listSessions: jest.fn(async () => [...rows.values()]),
    createSession: jest.fn(async (data) => {
      const row = { ...data };
      rows.set(row.id, row);
      return row;
    }),
    updateSession: jest.fn(async (id, patch) => {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    }),
    deleteSession: jest.fn(async (id) => rows.delete(id)),
  };
}

function makeEngine(overrides = {}) {
  return {
    initialize: jest.fn(async () => {}),
    disconnect: jest.fn(async () => {}),
    forceDestroy: jest.fn(async () => {}),
    logout: jest.fn(async () => {}),
    getQRCode: jest.fn(() => null),
    requestPairingCode: jest.fn(async () => 'ABCD-1234'),
    ...overrides,
  };
}

function makeProvider(engine) {
  return {
    createEngine: jest.fn(() => engine),
    purgeSessionData: jest.fn(async () => {}),
  };
}

function makeEvents() {
  return {
    qr: jest.fn(),
    status: jest.fn(),
    authenticated: jest.fn(),
    disconnected: jest.fn(),
  };
}

function makeService({
  sessionService = makeSessionService({ s1: {} }),
  engine = makeEngine(),
  provider,
  events = makeEvents(),
  registry = new EngineRegistry(),
  config = { sessions: { maxConcurrent: 0 } },
} = {}) {
  const engineProvider = provider || makeProvider(engine);
  const service = new SessionLifecycleService({
    sessionService,
    engineProvider,
    registry,
    events,
    config,
    logger: { warn: jest.fn() },
  });
  return { service, sessionService, engine, engineProvider, events, registry };
}

describe('SessionLifecycleService.start', () => {
  test('rejects an unknown session with 404', async () => {
    const { service } = makeService();
    await expect(service.start('missing')).rejects.toMatchObject({ status: 404 });
  });

  test('creates the engine, registers it and marks the row initializing', async () => {
    const { service, engine, engineProvider, registry, sessionService } = makeService();
    const result = await service.start('s1');

    expect(engineProvider.createEngine).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', dbSessionId: 's1' }),
    );
    expect(engine.initialize).toHaveBeenCalledTimes(1);
    expect(registry.get('s1')).toBe(engine);
    expect(sessionService.rows.get('s1').status).toBe('initializing');
    expect(result.id).toBe('s1');
  });

  test('refuses to start a session that is already started', async () => {
    const { service, registry, engine } = makeService();
    registry.set('s1', engine);
    await expect(service.start('s1')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/already started/i),
    });
  });

  test('enforces the max-concurrent-sessions cap', async () => {
    const { service, registry, engine } = makeService({
      config: { sessions: { maxConcurrent: 1 } },
    });
    registry.set('other', engine);
    await expect(service.start('s1')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/maximum concurrent/i),
    });
  });

  test('tears down the engine and records FAILED when initialize throws', async () => {
    const engine = makeEngine({
      initialize: jest.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { service, registry, sessionService } = makeService({ engine });

    await expect(service.start('s1')).rejects.toThrow('boom');
    expect(engine.forceDestroy).toHaveBeenCalledTimes(1);
    expect(registry.has('s1')).toBe(false);
    expect(sessionService.rows.get('s1').status).toBe('failed');
  });

  test('surfaces the init timeout as 504 and retires the engine', async () => {
    jest.useFakeTimers();
    try {
      const engine = makeEngine({ initialize: jest.fn(() => new Promise(() => {})) });
      const { service, registry } = makeService({ engine });
      const pending = service.start('s1');
      pending.catch(() => {});
      await jest.advanceTimersByTimeAsync(resolveEngineInitTimeoutMs() + 1_000);
      await expect(pending).rejects.toMatchObject({ status: 504 });
      expect(registry.has('s1')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SessionLifecycleService.stop', () => {
  test('disconnects the engine, unregisters it and persists the stopped state', async () => {
    const { service, engine, registry, sessionService } = makeService();
    registry.set('s1', engine);

    await service.stop('s1');

    expect(engine.disconnect).toHaveBeenCalledTimes(1);
    expect(registry.has('s1')).toBe(false);
    expect(sessionService.rows.get('s1')).toMatchObject({
      status: 'disconnected',
      desiredState: 'stopped',
    });
  });

  test('escalates to forceDestroy when graceful disconnect fails', async () => {
    const engine = makeEngine({
      disconnect: jest.fn(async () => {
        throw new Error('socket stuck');
      }),
    });
    const { service, registry, sessionService } = makeService({ engine });
    registry.set('s1', engine);

    await service.stop('s1');

    expect(engine.forceDestroy).toHaveBeenCalledTimes(1);
    expect(registry.has('s1')).toBe(false);
    expect(sessionService.rows.get('s1').status).toBe('disconnected');
  });

  test('reports a retryable partial teardown with a stable code', async () => {
    const engine = makeEngine({
      disconnect: jest.fn(async () => {
        throw new Error('socket stuck');
      }),
      forceDestroy: jest.fn(async () => {
        throw new Error('kill failed');
      }),
    });
    const { service, registry, sessionService } = makeService({ engine });
    registry.set('s1', engine);

    await expect(service.stop('s1')).rejects.toMatchObject({
      status: 502,
      code: 'SESSION_STOP_INCOMPLETE',
    });
    expect(registry.has('s1')).toBe(false);
    expect(sessionService.rows.get('s1').status).toBe('disconnected');
  });

  test('is a no-op for a session that is not running', async () => {
    const { service, sessionService } = makeService();
    await service.stop('s1');
    expect(sessionService.rows.get('s1').status).toBe('disconnected');
  });
});

describe('SessionLifecycleService.logout', () => {
  test('requires a live engine', async () => {
    const { service } = makeService();
    await expect(service.logout('s1')).rejects.toMatchObject({ status: 400 });
  });

  test('unlinks the device, clears the phone and unregisters the engine', async () => {
    const { service, engine, registry, sessionService } = makeService({
      sessionService: makeSessionService({ s1: { status: 'ready', phone: '628123' } }),
    });
    registry.set('s1', engine);

    await service.logout('s1');

    expect(engine.logout).toHaveBeenCalledTimes(1);
    expect(registry.has('s1')).toBe(false);
    expect(sessionService.rows.get('s1')).toMatchObject({
      status: 'disconnected',
      phone: null,
      desiredState: 'stopped',
    });
  });

  test('maps EngineNotReadyError to 400 and still clears local state', async () => {
    const engine = makeEngine({
      logout: jest.fn(async () => {
        const error = new Error('Session is not linked');
        error.name = 'EngineNotReadyError';
        throw error;
      }),
    });
    const { service, registry, sessionService } = makeService({
      engine,
      sessionService: makeSessionService({ s1: { status: 'ready', phone: '628123' } }),
    });
    registry.set('s1', engine);

    await expect(service.logout('s1')).rejects.toMatchObject({ status: 400 });
    expect(registry.has('s1')).toBe(false);
    expect(sessionService.rows.get('s1')).toMatchObject({ status: 'disconnected', phone: null });
  });

  test('reports an incomplete unlink with a stable code', async () => {
    const engine = makeEngine({
      logout: jest.fn(async () => {
        throw new Error('unlink failed');
      }),
    });
    const { service, registry, sessionService } = makeService({ engine });
    registry.set('s1', engine);

    await expect(service.logout('s1')).rejects.toMatchObject({
      status: 502,
      code: 'SESSION_LOGOUT_INCOMPLETE',
    });
    expect(registry.has('s1')).toBe(false);
    expect(sessionService.rows.get('s1').status).toBe('disconnected');
  });
});

describe('SessionLifecycleService.forceKill', () => {
  test('force-destroys the engine and preserves credentials', async () => {
    const { service, engine, engineProvider, registry, sessionService } = makeService();
    registry.set('s1', engine);

    await service.forceKill('s1');

    expect(engine.forceDestroy).toHaveBeenCalledTimes(1);
    expect(engine.logout).not.toHaveBeenCalled();
    expect(engineProvider.purgeSessionData).not.toHaveBeenCalled();
    expect(registry.has('s1')).toBe(false);
    expect(sessionService.rows.get('s1')).toMatchObject({
      status: 'disconnected',
      desiredState: 'stopped',
    });
  });

  test('requires a live engine', async () => {
    const { service } = makeService();
    await expect(service.forceKill('s1')).rejects.toMatchObject({ status: 400 });
  });

  test('reports a failed force-kill with a stable code', async () => {
    const engine = makeEngine({
      forceDestroy: jest.fn(async () => {
        throw new Error('kill failed');
      }),
    });
    const { service, registry } = makeService({ engine });
    registry.set('s1', engine);

    await expect(service.forceKill('s1')).rejects.toMatchObject({
      status: 502,
      code: 'SESSION_FORCE_KILL_INCOMPLETE',
    });
    expect(registry.has('s1')).toBe(false);
  });
});

describe('SessionLifecycleService.deleteSession', () => {
  test('stops the engine and purges both credential dirs before deleting the row', async () => {
    const { service, engine, engineProvider, registry, sessionService } = makeService({
      sessionService: makeSessionService({ s1: { name: 'legacy-name' } }),
    });
    registry.set('s1', engine);

    await expect(service.deleteSession('s1')).resolves.toBe(true);

    expect(engine.disconnect).toHaveBeenCalledTimes(1);
    expect(engineProvider.purgeSessionData).toHaveBeenCalledWith('s1', 'legacy-name');
    expect(sessionService.deleteSession).toHaveBeenCalledWith('s1');
    expect(sessionService.rows.has('s1')).toBe(false);
  });

  test('does not pass a legacy name that matches the id', async () => {
    const { service, engineProvider } = makeService({
      sessionService: makeSessionService({ s1: { name: 's1' } }),
    });
    await service.deleteSession('s1');
    expect(engineProvider.purgeSessionData).toHaveBeenCalledWith('s1', undefined);
  });

  test('rejects an unknown session with 404', async () => {
    const { service } = makeService();
    await expect(service.deleteSession('missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('SessionLifecycleService QR and pairing', () => {
  test('returns the QR while the engine has one', async () => {
    const engine = makeEngine({ getQRCode: jest.fn(() => 'qr-data') });
    const { service, registry } = makeService({ engine });
    registry.set('s1', engine);
    await expect(service.getQRCode('s1')).resolves.toEqual({ qrCode: 'qr-data', status: 'created' });
  });

  test('explains that a ready session needs no QR', async () => {
    const engine = makeEngine({ getQRCode: jest.fn(() => null) });
    const { service, registry } = makeService({
      engine,
      sessionService: makeSessionService({ s1: { status: 'ready' } }),
    });
    registry.set('s1', engine);
    await expect(service.getQRCode('s1')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/already authenticated/i),
    });
  });

  test('asks the caller to wait when no QR exists yet', async () => {
    const { service, registry, engine } = makeService();
    registry.set('s1', engine);
    await expect(service.getQRCode('s1')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/not ready/i),
    });
  });

  test('requires a phone number for pairing', async () => {
    const { service } = makeService();
    await expect(service.requestPairingCode('s1', '')).rejects.toMatchObject({ status: 400 });
  });

  test('refuses pairing for an authenticated session', async () => {
    const engine = makeEngine();
    const { service, registry } = makeService({
      engine,
      sessionService: makeSessionService({ s1: { status: 'ready' } }),
    });
    registry.set('s1', engine);
    await expect(service.requestPairingCode('s1', '628123')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/already authenticated/i),
    });
    expect(engine.requestPairingCode).not.toHaveBeenCalled();
  });

  test('returns the pairing code and current status', async () => {
    const engine = makeEngine();
    const { service, registry } = makeService({ engine });
    registry.set('s1', engine);
    await expect(service.requestPairingCode('s1', '628123')).resolves.toEqual({
      pairingCode: 'ABCD-1234',
      status: 'created',
    });
    expect(engine.requestPairingCode).toHaveBeenCalledWith('628123');
  });
});

describe('SessionLifecycleService engine callbacks', () => {
  test('persists ready state, clears lastError and emits events', async () => {
    const engine = makeEngine();
    const { service, sessionService, events, registry } = makeService({ engine });
    registry.set('s1', engine);
    const callbacks = service.buildCallbacks('s1', engine);

    callbacks.onReady('628123', 'Bob');
    await flush();

    expect(sessionService.rows.get('s1')).toMatchObject({
      status: 'ready',
      phone: '628123',
      pushName: 'Bob',
      desiredState: null,
    });
    expect(events.authenticated).toHaveBeenCalledWith('s1', { phone: '628123', pushName: 'Bob' });
    expect(events.status).toHaveBeenCalledWith('s1', 'ready', {
      phone: '628123',
      pushName: 'Bob',
    });
    expect(service.decorate(sessionService.rows.get('s1')).lastError).toBeNull();
  });

  test('records a terminal error and retires the engine', async () => {
    const engine = makeEngine();
    const { service, sessionService, registry } = makeService({ engine });
    registry.set('s1', engine);

    await service.applyError('s1', engine, 'auth rejected');

    expect(registry.has('s1')).toBe(false);
    expect(sessionService.rows.get('s1').status).toBe('failed');
    expect(service.decorate(sessionService.rows.get('s1')).lastError).toBe('auth rejected');
  });

  test('ignores callbacks from a superseded engine', async () => {
    const engine = makeEngine();
    const replacement = makeEngine();
    const { service, sessionService, registry } = makeService({ engine });
    registry.set('s1', engine);
    registry.set('s1', replacement);
    const staleCallbacks = service.buildCallbacks('s1', engine);

    staleCallbacks.onReady('628999', 'Stale');
    await flush();

    expect(sessionService.rows.get('s1').status).toBe('created');
    expect(sessionService.rows.get('s1').phone).toBeUndefined();
  });

  test('serializes concurrent read-modify-write updates on one session', async () => {
    const engine = makeEngine();
    const { service, sessionService, registry } = makeService({ engine });
    registry.set('s1', engine);

    await Promise.all([
      service.applyReady('s1', '628123', 'Bob'),
      service.applyStatus('s1', 'qr_ready'),
    ]);

    // Both writes must land; the last queued one wins deterministically instead of interleaving.
    expect(sessionService.updateSession).toHaveBeenCalledTimes(2);
    expect(sessionService.rows.get('s1').status).toBe('qr_ready');
    expect(sessionService.rows.get('s1').phone).toBe('628123');
  });
});

describe('resolveMaxConcurrentSessions', () => {
  test.each([
    [0, null],
    [-1, null],
    [undefined, null],
    ['abc', null],
    [1, 1],
    ['3', 3],
  ])('maps %p to %p', (input, expected) => {
    expect(resolveMaxConcurrentSessions({ sessions: { maxConcurrent: input } })).toBe(expected);
  });
});
