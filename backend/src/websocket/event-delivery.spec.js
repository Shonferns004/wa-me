const { Server } = require('socket.io');
const { io } = require('C:/Users/ADMIN/Desktop/Projects/OpenWA-main/frontend/node_modules/socket.io-client');
const http = require('http');
const { attachSocket, setIo } = require('./index');
const { BaileysConnection } = require('../engine/adapters/baileys/connection');

jest.mock('../database', () => ({
  getDb: () => ({
    getRepository: () => ({
      findOne: async ({ where }) => {
        const map = {
          'hash-a': { isActive: true, allowedSessions: ['session-a'] },
          'hash-b': { isActive: true, allowedSessions: ['session-b'] },
          'hash-none': { isActive: true, allowedSessions: [] },
        };
        return map[where.keyHash] || null;
      },
    }),
  }),
}));

jest.mock('../modules/auth/api-key-hash', () => ({
  hashApiKey: (raw) => {
    if (raw === 'key-a') return 'hash-a';
    if (raw === 'key-b') return 'hash-b';
    if (raw === 'key-none') return 'hash-none';
    return 'hash-unknown';
  },
}));

describe('Event delivery & isolation', () => {
  let server, ioServer, port, clientA, clientB;

  beforeAll((done) => {
    server = http.createServer();
    ioServer = new Server(server, { cors: { origin: '*' } });
    setIo(ioServer);
    attachSocket(ioServer);
    server.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    if (clientA) clientA.disconnect();
    if (clientB) clientB.disconnect();
    ioServer.close();
    server.close(done);
  });

  function connectClient(apiKey) {
    return new Promise((resolve) => {
      const c = io(`http://localhost:${port}/events`, { auth: { apiKey } });
      c.on('connect', () => resolve(c));
    });
  }

  function join(client, sessionId) {
    return new Promise((resolve) => {
      client.emit('join:session', sessionId, (ack) => resolve(ack));
    });
  }

  beforeEach(async () => {
    clientA = await connectClient('key-a');
    clientB = await connectClient('key-b');
    await join(clientA, 'session-a');
    await join(clientB, 'session-b');
  });

  afterEach(() => {
    if (clientA) clientA.disconnect();
    if (clientB) clientB.disconnect();
    clientA = null;
    clientB = null;
  });

  test('A receives session-a QR, B does not', (done) => {
    const connA = new BaileysConnection('session-a', '/tmp/sa', ioServer);
    let receivedA = false;
    let receivedB = false;
    clientA.on('message', (msg) => {
      if (msg?.payload?.event === 'session.qr') receivedA = true;
    });
    clientB.on('message', (msg) => {
      if (msg?.payload?.event === 'session.qr') receivedB = true;
    });
    connA._emit('session.qr', { qrCode: 'QR-A' });
    setTimeout(() => {
      expect(receivedA).toBe(true);
      expect(receivedB).toBe(false);
      done();
    }, 200);
  });

  test('B receives session-b QR, A does not', (done) => {
    const connB = new BaileysConnection('session-b', '/tmp/sb', ioServer);
    let receivedA = false;
    let receivedB = false;
    clientA.on('message', (msg) => {
      if (msg?.payload?.event === 'session.qr') receivedA = true;
    });
    clientB.on('message', (msg) => {
      if (msg?.payload?.event === 'session.qr') receivedB = true;
    });
    connB._emit('session.qr', { qrCode: 'QR-B' });
    setTimeout(() => {
      expect(receivedA).toBe(false);
      expect(receivedB).toBe(true);
      done();
    }, 200);
  });

  test('status event isolation', (done) => {
    const connA = new BaileysConnection('session-a', '/tmp/sa', ioServer);
    let receivedB = false;
    clientB.on('message', (msg) => {
      if (msg?.payload?.event === 'session.status') receivedB = true;
    });
    connA._emit('session.status', { status: 'connected' });
    setTimeout(() => {
      expect(receivedB).toBe(false);
      done();
    }, 200);
  });

  test('unauthorized client cannot join', async () => {
    const c = await connectClient('key-b');
    const ack = await join(c, 'session-a');
    expect(ack.ok).toBe(false);
    c.disconnect();
  });

  test('no global broadcast', (done) => {
    const connA = new BaileysConnection('session-a', '/tmp/sa', ioServer);
    let globalReceived = false;
    const c = io(`http://localhost:${port}/events`, { auth: { apiKey: 'key-a' } });
    c.on('message', () => { globalReceived = true; });
    connA._emit('session.qr', { qrCode: 'QR-X' });
    setTimeout(() => {
      expect(globalReceived).toBe(false);
      c.disconnect();
      done();
    }, 200);
  });

  test('frontend contract envelope', (done) => {
    const connA = new BaileysConnection('session-a', '/tmp/sa', ioServer);
    clientA.on('message', (msg) => {
      expect(msg.type).toBe('event');
      expect(msg.payload).toBeDefined();
      expect(typeof msg.timestamp).toBe('number');
      expect(msg.payload.event).toBe('session.qr');
      expect(msg.payload.data.qrCode).toBe('QR-CONTRACT');
      done();
    });
    connA._emit('session.qr', { qrCode: 'QR-CONTRACT' });
  });
});
