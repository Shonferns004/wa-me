const { getIo } = require('../../websocket');

/**
 * Socket.IO emitter for the Express session lifecycle.
 *
 * The wire format is the one the dashboard already parses (frontend/src/hooks/useWebSocket.js):
 *   { type: 'event', payload: { event, sessionId, data }, timestamp }
 * on the `/events` namespace, room `session:<id>`. Event names and payload keys mirror the NestJS
 * EventsGateway so the migration does not need a frontend change.
 */
class SessionEvents {
  constructor(ioProvider = getIo) {
    this.ioProvider = ioProvider;
  }

  emit(event, sessionId, data = {}) {
    const io = this.ioProvider();
    if (!io) return;
    io.of('/events').to(`session:${sessionId}`).emit('message', {
      type: 'event',
      payload: { event, sessionId, data },
      timestamp: Date.now(),
    });
  }

  status(sessionId, status, extra = {}) {
    this.emit('session.status', sessionId, { status, ...extra });
  }

  qr(sessionId, qrCode) {
    this.emit('session.qr', sessionId, { qrCode });
  }

  authenticated(sessionId, { phone, pushName } = {}) {
    this.emit('session.authenticated', sessionId, { phone, pushName });
  }

  disconnected(sessionId, { reason } = {}) {
    this.emit('session.disconnected', sessionId, { reason });
  }
}

module.exports = { SessionEvents };
