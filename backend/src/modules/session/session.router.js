const express = require('express');
const { SessionService } = require('./session.express.service');
const { AuthService } = require('../auth/auth.express.service');
const { SessionLifecycleService } = require('./session-lifecycle.service');

/**
 * Express session API.
 *
 * CRUD and the read-only config/proxy projections come from SessionService; every verb that touches
 * a running engine (start/stop/logout/force-kill/QR/pairing) is delegated to SessionLifecycleService,
 * which owns the engine registry and the Nest-parity teardown rules. The router itself stays a thin
 * HTTP adapter so it can be constructed with fakes in tests.
 */
function createSessionRouter({
  sessionService = new SessionService(),
  authService = new AuthService(),
  lifecycle = new SessionLifecycleService({ sessionService }),
} = {}) {
  const router = express.Router();

  function authMiddleware(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ message: 'Unauthorized' });
    authService
      .validateApiKey(key)
      .then((validated) => {
        if (!validated) return res.status(401).json({ message: 'Unauthorized' });
        req.apiKey = validated;
        next();
      })
      .catch(() => res.status(500).json({ message: 'Internal Server Error' }));
  }

  router.use(authMiddleware);

  // Parity with NestJS `@SessionScoped()`: a key restricted to `allowedSessions` may only address
  // those ids. An empty/null list is unrestricted. Runs for every `/:id` route below.
  router.param('id', (req, res, next, id) => {
    const allowed = req.apiKey?.allowedSessions;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  });

  const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.get(
    '/',
    handle(async (req, res) => {
      res.json(await lifecycle.listSessions(req.apiKey?.allowedSessions));
    }),
  );

  router.post(
    '/',
    handle(async (req, res) => {
      const session = await lifecycle.createSession(req.body || {});
      res.status(201).json(session);
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      const session = await lifecycle.getSession(req.params.id);
      if (!session) return res.status(404).json({ message: 'Not found' });
      res.json(session);
    }),
  );

  router.delete(
    '/:id',
    handle(async (req, res) => {
      const removed = await lifecycle.deleteSession(req.params.id);
      if (!removed) return res.status(404).json({ message: 'Not found' });
      res.status(204).send();
    }),
  );

  router.get(
    '/:id/config',
    handle(async (req, res) => {
      const session = await sessionService.getSessionById(req.params.id);
      if (!session) return res.status(404).json({ message: 'Not found' });
      res.json(session.config || {});
    }),
  );

  router.get(
    '/:id/proxy',
    handle(async (req, res) => {
      const session = await sessionService.getSessionById(req.params.id);
      if (!session) return res.status(404).json({ message: 'Not found' });
      res.json({ proxyUrl: session.proxyUrl || null, proxyType: session.proxyType || null });
    }),
  );

  router.post(
    '/:id/start',
    handle(async (req, res) => {
      const session = await lifecycle.start(req.params.id);
      res.json(lifecycle.decorate(session));
    }),
  );

  router.post(
    '/:id/stop',
    handle(async (req, res) => {
      const session = await lifecycle.stop(req.params.id);
      res.json(lifecycle.decorate(session));
    }),
  );

  router.post(
    '/:id/logout',
    handle(async (req, res) => {
      const session = await lifecycle.logout(req.params.id);
      res.json(lifecycle.decorate(session));
    }),
  );

  router.post(
    '/:id/force-kill',
    handle(async (req, res) => {
      const session = await lifecycle.forceKill(req.params.id);
      res.json(lifecycle.decorate(session));
    }),
  );

  router.get(
    '/:id/qr',
    handle(async (req, res) => {
      res.json(await lifecycle.getQRCode(req.params.id));
    }),
  );

  router.post(
    '/:id/pairing-code',
    handle(async (req, res) => {
      const result = await lifecycle.requestPairingCode(req.params.id, req.body?.phoneNumber);
      res.status(201).json(result);
    }),
  );

  return router;
}

module.exports = createSessionRouter();
module.exports.createSessionRouter = createSessionRouter;
