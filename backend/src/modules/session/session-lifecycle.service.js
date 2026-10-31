const configuration = require('../../config/configuration').default;
const { EngineRegistry } = require('../../engine/engine-registry.service');
const { resolveEngineInitTimeoutMs } = require('../../engine/engine-init-timeout');
const { SessionStatus } = require('./entities/session.entity');
const { SessionEngineProvider } = require('./session-engine.provider');
const { SessionEvents } = require('./session-events');

const ENGINE_STATUSES = new Set(Object.values(SessionStatus));

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

async function swallow(promise) {
  try {
    await promise;
    return true;
  } catch {
    return false;
  }
}

/**
 * Express session lifecycle: start / stop / logout / force-kill / QR / pairing, backed by the real
 * engine adapters and the shared EngineRegistry.
 *
 * Parity notes (Phase 4.1.2C-3D-2, against the NestJS SessionEngineControls):
 * - stop() disconnects, escalating to forceDestroy when graceful teardown fails.
 * - logout() requires a live engine, lets the engine unlink the device (which removes its credentials)
 *   and clears the stored phone.
 * - forceKill() requires a live engine, force-destroys the browser/socket and PRESERVES credentials.
 * - delete() stops the engine and purges BOTH engines' credential directories before removing the row.
 *
 * Not migrated yet (owned by later phases): ownership leases / multi-node forwarding, automatic
 * reconnect orchestration, webhooks, audit logging and the message pipeline.
 */
class SessionLifecycleService {
  constructor({
    sessionService,
    engineProvider = new SessionEngineProvider(),
    registry = new EngineRegistry(),
    events = new SessionEvents(),
    config = configuration(),
    logger = console,
  } = {}) {
    this.sessionService = sessionService;
    this.engineProvider = engineProvider;
    this.registry = registry;
    this.events = events;
    this.logger = logger;
    this.maxConcurrent = resolveMaxConcurrentSessions(config);
    /** Per-session write chain: engine callbacks can fire together, and concurrent read-modify-write
     *  updates on one row would otherwise clobber each other (e.g. a status write landing after the
     *  ready write and erasing the phone number). */
    this.writeChains = new Map();
    /** Transient terminal-failure reasons, surfaced as `lastError` (never persisted). */
    this.errors = new Map();
  }

  engineLoaded(session) {
    return this.registry.has(session.id);
  }

  decorate(session) {
    if (!session) return session;
    return {
      ...session,
      engineLoaded: this.engineLoaded(session),
      lastError: this.errors.get(session.id) ?? null,
    };
  }

  async requireSession(id) {
    const session = await this.sessionService.getSessionById(id);
    if (!session) throw httpError(404, `Session ${id} not found`);
    return session;
  }

  async requireEngine(id) {
    const engine = this.registry.get(id);
    if (!engine) {
      throw httpError(400, 'Session is not started. Call POST /sessions/:sessionId/start first.');
    }
    return engine;
  }

  /**
   * Chain a read-modify-write on one session. Returns the real promise so lifecycle verbs can surface
   * failures; the chain itself stores a swallowed promise so one failed callback does not poison the
   * queue for the next one.
   */
  write(id, fn) {
    const previous = this.writeChains.get(id) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tracked = next.catch(() => {});
    this.writeChains.set(id, tracked);
    tracked.then(() => {
      if (this.writeChains.get(id) === tracked) this.writeChains.delete(id);
    });
    return next;
  }

  buildCallbacks(id, engine) {
    const live = () => this.registry.isLive(id, engine);
    const run = (fn) => {
      if (!live()) return;
      fn().catch((error) => {
        this.logger.warn?.(
          `Session ${id}: failed to apply engine callback: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };
    return {
      onQRCode: (qrCode) =>
        run(async () => {
          await this.write(id, () =>
            this.sessionService.updateSession(id, { status: SessionStatus.QR_READY }),
          );
          this.events.qr(id, qrCode);
          this.events.status(id, SessionStatus.QR_READY);
        }),
      onStateChanged: (status) => run(() => this.applyStatus(id, status)),
      onReady: (phone, pushName) => run(() => this.applyReady(id, phone, pushName)),
      onDisconnected: (reason) => run(() => this.applyDisconnected(id, engine, reason)),
      onError: (reason) => run(() => this.applyError(id, engine, reason)),
      onActionRequired: (reason) =>
        run(async () => {
          await this.write(id, () =>
            this.sessionService.updateSession(id, { status: SessionStatus.ACTION_REQUIRED }),
          );
          this.events.status(id, SessionStatus.ACTION_REQUIRED, { reason });
        }),
      // Restriction tracking is a later phase; the callback must exist so the adapter does not throw.
      onAccountRestriction: () => {},
      // The adapter hands us the credential-removal promise so it can be awaited/tracked. We only
      // need to keep it from becoming an unhandled rejection.
      onCredentialTeardownStarted: (cleanup) => {
        if (cleanup && typeof cleanup.catch === 'function') cleanup.catch(() => {});
      },
    };
  }

  async applyStatus(id, status) {
    if (!ENGINE_STATUSES.has(status)) return;
    await this.write(id, () => this.sessionService.updateSession(id, { status }));
    this.events.status(id, status);
  }

  async applyReady(id, phone, pushName) {
    const now = new Date();
    await this.write(id, () =>
      this.sessionService.updateSession(id, {
        status: SessionStatus.READY,
        ...(phone ? { phone } : {}),
        ...(pushName ? { pushName } : {}),
        connectedAt: now,
        lastActiveAt: now,
        desiredState: null,
      }),
    );
    this.errors.delete(id);
    this.events.authenticated(id, { phone, pushName });
    this.events.status(id, SessionStatus.READY, { phone, pushName });
  }

  async applyDisconnected(id, engine, reason) {
    // The adapter reported a terminal disconnect: it will not reconnect on its own in the Express
    // layer, so drop the dead instance to let a later start() work. Explicit stop/logout/force-kill
    // already removed it, and the `isLive` guard means those paths never reach this write.
    this.registry.deleteIfLive(id, engine);
    await this.write(id, () =>
      this.sessionService.updateSession(id, { status: SessionStatus.DISCONNECTED }),
    );
    this.events.disconnected(id, { reason });
    this.events.status(id, SessionStatus.DISCONNECTED);
  }

  async applyError(id, engine, reason) {
    this.errors.set(id, reason ? String(reason) : 'Unknown engine error');
    this.registry.deleteIfLive(id, engine);
    await this.write(id, () =>
      this.sessionService.updateSession(id, { status: SessionStatus.FAILED }),
    );
    this.events.status(id, SessionStatus.FAILED, { reason: this.errors.get(id) });
  }

  async initializeWithTimeout(id, engine, session) {
    const timeoutMs = resolveEngineInitTimeoutMs();
    const callbacks = this.buildCallbacks(id, engine);
    const initPromise = Promise.resolve().then(() => engine.initialize(callbacks));
    initPromise.catch(() => {});
    let timer;
    try {
      await Promise.race([
        initPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              httpError(
                504,
                `Engine initialization timed out after ${timeoutMs}ms: the engine did not finish starting. ` +
                  'WhatsApp Web, the network or the session proxy may be unreachable, or the browser may have ' +
                  'stalled during startup. Retry the session; for chronically slow first boots, raise ' +
                  'WWEBJS_AUTH_TIMEOUT_MS.',
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return session;
  }

  async listSessions(allowedSessions) {
    const sessions = await this.sessionService.listSessions(allowedSessions);
    return sessions.map((session) => this.decorate(session));
  }

  async getSession(id) {
    return this.decorate(await this.sessionService.getSessionById(id));
  }

  async createSession(data) {
    const session = await this.sessionService.createSession(data);
    return this.decorate(session);
  }

  async start(id) {
    const session = await this.requireSession(id);
    if (this.registry.has(id)) {
      throw httpError(400, 'Session is already started');
    }
    if (this.maxConcurrent !== null && this.registry.size >= this.maxConcurrent) {
      throw httpError(400, `Maximum concurrent sessions reached (${this.maxConcurrent})`);
    }

    const engine = this.engineProvider.createEngine({
      sessionId: id,
      dbSessionId: id,
      proxyUrl: session.proxyUrl || undefined,
      proxyType: session.proxyType || undefined,
    });
    this.registry.set(id, engine, session.proxyUrl || undefined);
    this.errors.delete(id);

    try {
      await this.write(id, () =>
        this.sessionService.updateSession(id, {
          status: SessionStatus.INITIALIZING,
          desiredState: null,
        }),
      );
      await this.initializeWithTimeout(id, engine, session);
    } catch (error) {
      const wasLive = this.registry.deleteIfLive(id, engine);
      if (wasLive) {
        await swallow(engine.forceDestroy());
        await swallow(
          this.write(id, () =>
            this.sessionService.updateSession(id, { status: SessionStatus.FAILED }),
          ),
        );
      }
      throw error;
    }

    return this.requireSession(id);
  }

  async stop(id) {
    await this.requireSession(id);
    const engine = this.registry.get(id);
    if (engine) {
      let tornDown = await swallow(engine.disconnect());
      if (!tornDown) tornDown = await swallow(engine.forceDestroy());
      this.registry.deleteIfLive(id, engine);
      if (!tornDown) {
        await this.write(id, () =>
          this.sessionService.updateSession(id, { status: SessionStatus.DISCONNECTED }),
        );
        throw httpError(
          502,
          'Session was stopped locally, but the engine teardown did not complete: the engine process ' +
            'may still be running. Retry the stop; restart the node to reap a leaked process.',
          'SESSION_STOP_INCOMPLETE',
        );
      }
    }
    await this.write(id, () =>
      this.sessionService.updateSession(id, {
        status: SessionStatus.DISCONNECTED,
        desiredState: 'stopped',
      }),
    );
    return this.requireSession(id);
  }

  async logout(id) {
    await this.requireSession(id);
    const engine = await this.requireEngine(id);
    // Keep the thrown error (not just a boolean): EngineNotReadyError is the engine's way of saying
    // the session has no linked device, which the API answers as 400 rather than 502.
    let unlinked = true;
    let failure;
    try {
      await engine.logout();
    } catch (error) {
      failure = error;
      unlinked = false;
    }
    this.registry.deleteIfLive(id, engine);
    await this.write(id, () =>
      this.sessionService.updateSession(id, {
        status: SessionStatus.DISCONNECTED,
        phone: null,
        desiredState: 'stopped',
      }),
    );
    if (failure && failure.name === 'EngineNotReadyError') {
      throw httpError(400, failure.message);
    }
    if (!unlinked) {
      throw httpError(
        502,
        'Session was stopped locally, but the logout operation is incomplete — the device may still be ' +
          'linked. Start the session and retry the logout.',
        'SESSION_LOGOUT_INCOMPLETE',
      );
    }
    return this.requireSession(id);
  }

  async forceKill(id) {
    await this.requireSession(id);
    const engine = await this.requireEngine(id);
    const killed = await swallow(engine.forceDestroy());
    this.registry.deleteIfLive(id, engine);
    await this.write(id, () =>
      this.sessionService.updateSession(id, {
        status: SessionStatus.DISCONNECTED,
        desiredState: 'stopped',
      }),
    );
    if (!killed) {
      throw httpError(
        502,
        'Session was stopped locally, but the engine force-kill did not complete: the engine process may ' +
          'still be running. Restart the node to reap a leaked process.',
        'SESSION_FORCE_KILL_INCOMPLETE',
      );
    }
    return this.requireSession(id);
  }

  async deleteSession(id) {
    const session = await this.requireSession(id);
    const engine = this.registry.get(id);
    if (engine) {
      const tornDown = await swallow(engine.disconnect());
      if (!tornDown) await swallow(engine.forceDestroy());
      this.registry.deleteIfLive(id, engine);
    }
    const legacyName = session.name !== session.id ? session.name : undefined;
    await this.engineProvider.purgeSessionData(id, legacyName);
    this.errors.delete(id);
    await this.sessionService.deleteSession(id);
    return true;
  }

  async getQRCode(id) {
    const session = await this.requireSession(id);
    const engine = await this.requireEngine(id);
    const qrCode = engine.getQRCode();
    if (!qrCode) {
      if (session.status === SessionStatus.READY) {
        throw httpError(400, 'Session is already authenticated, no QR code needed');
      }
      throw httpError(400, 'QR code is not ready yet. Please wait...');
    }
    return { qrCode, status: session.status };
  }

  async requestPairingCode(id, phoneNumber) {
    if (!phoneNumber) throw httpError(400, 'phoneNumber is required');
    const session = await this.requireSession(id);
    const engine = await this.requireEngine(id);
    if (session.status === SessionStatus.READY) {
      throw httpError(400, 'Session is already authenticated, no pairing needed');
    }
    const pairingCode = await engine.requestPairingCode(phoneNumber);
    return { pairingCode, status: session.status };
  }
}

function resolveMaxConcurrentSessions(config) {
  const raw = config?.sessions?.maxConcurrent;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

module.exports = { SessionLifecycleService, resolveMaxConcurrentSessions };
