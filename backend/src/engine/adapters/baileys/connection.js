const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const fs = require('fs');
const { getIo } = require('../../../websocket');

class BaileysConnection {
  constructor(sessionId, sessionDir, io) {
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.io = io || null;
    this.sock = null;
    this.status = 'disconnected';
  }

  _emit(frontendEvent, data) {
    const io = this.io || getIo();
    if (!io) return;
    const room = `session:${this.sessionId}`;
    const msg = {
      type: 'event',
      payload: { event: frontendEvent, sessionId: this.sessionId, data },
      timestamp: Date.now(),
    };
    io.of('/events').to(room).emit('message', msg);
  }

  async connect() {
    if (this.sock) return this.sock;
    if (!fs.existsSync(this.sessionDir)) fs.mkdirSync(this.sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    this.sock = makeWASocket({ version, auth: state, printQRInTerminal: false });
    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.status = 'qr';
        this._emit('session.qr', { qrCode: qr });
      }
      if (connection === 'connecting') {
        this.status = 'connecting';
        this._emit('session.status', { status: 'connecting' });
      }
      if (connection === 'open') {
        this.status = 'connected';
        this._emit('session.status', { status: 'connected' });
      }
      if (connection === 'close') {
        this.status = 'disconnected';
        const code = lastDisconnect?.error?.output?.statusCode;
        this._emit('session.status', { status: 'disconnected', code });
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(() => this.connect().catch(() => {}), 3000);
        }
      }
    });
    return this.sock;
  }

  async disconnect() {
    try { this.sock?.end(); } catch (e) {}
    this.sock = null;
    this.status = 'disconnected';
    this._emit('session.status', { status: 'disconnected' });
  }

  getStatus() { return this.status; }
}

module.exports = { BaileysConnection };
