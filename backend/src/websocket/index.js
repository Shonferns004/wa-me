const { getDb } = require('../database');
const { authorizeSocketJoin } = require('./authorization');

let ioInstance = null;
function setIo(io) { ioInstance = io; }
function getIo() { return ioInstance; }

function attachSocket(io) {
  const ns = io.of('/events');
  ns.use((socket, next) => {
    const key = socket.handshake.auth?.apiKey || socket.handshake.headers['x-api-key'];
    if (!key) return next(new Error('Unauthorized'));
    next();
  });
  ns.on('connection', (socket) => {
    socket.on('join:session', async (sessionId, ack) => {
      const key = socket.handshake.auth?.apiKey || socket.handshake.headers['x-api-key'];
      const result = await authorizeSocketJoin(sessionId, key);
      if (!result.ok) {
        if (typeof ack === 'function') ack({ ok: false, error: result.error });
        return;
      }
      await socket.join(`session:${sessionId}`);
      if (typeof ack === 'function') ack({ ok: true });
    });
  });
}

module.exports = { setIo, getIo, attachSocket, authorizeSocketJoin };
