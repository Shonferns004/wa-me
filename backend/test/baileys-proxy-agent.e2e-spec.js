"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// test/__mocks__ holds a stub of this package, which Jest applies to node modules on its own; this
// suite needs the real CONNECT negotiation.
jest.unmock('https-proxy-agent');
const https = __importStar(require("https"));
const net = __importStar(require("net"));
const baileys_lifecycle_1 = require("./../src/engine/adapters/baileys-lifecycle");
/**
 * The Baileys proxy agent against a proxy that accepts TCP and never answers CONNECT, the case the
 * connecting backstop exists for, through the real https-proxy-agent the unit suites stub out.
 * Each abandoned attempt must release its proxy socket, or every reconnect leaves one more open.
 */
describe('Baileys proxy agent (e2e)', () => {
    const proxy = async (onConnection) => {
        let onAccepted;
        const accepted = new Promise(resolve => (onAccepted = resolve));
        const server = net.createServer(socket => {
            // Reading is what lets the server see the client's FIN.
            socket.resume();
            socket.on('error', () => undefined);
            onConnection(socket);
            onAccepted(socket);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        return { server, accepted };
    };
    const silentProxy = () => proxy(() => undefined);
    const closedWithin = (socket, ms) => new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), ms);
        socket.once('close', () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
    // An https:// proxy is a TLS connection of its own, so a silent one stalls in the handshake rather
    // than in the CONNECT reply; the abort has to reach that socket too.
    it.each([
        // What ws does when Baileys ends a socket still in its handshake; the deadline is out of reach.
        ['aborted', 'http', 60_000, req => req.abort()],
        // Destroyed before it has a socket, which emits nothing: the CONNECT deadline closes it instead.
        ['destroyed', 'http', 300, req => req.destroy()],
        ['aborted', 'https', 60_000, req => req.abort()],
        ['destroyed', 'https', 300, req => req.destroy()],
    ])('closes the proxy socket when a request still waiting on CONNECT is %s (%s proxy)', async (_label, scheme, deadlineMs, stop) => {
        const { server, accepted } = await silentProxy();
        const req = https.request({
            host: '127.0.0.1',
            port: 443,
            agent: (0, baileys_lifecycle_1.createProxyAgent)(`${scheme}://127.0.0.1:${server.address().port}`, deadlineMs),
        });
        req.on('error', () => undefined);
        req.end();
        const socket = await accepted;
        try {
            stop(req);
            expect(await closedWithin(socket, 1000)).toBe(true);
        }
        finally {
            socket.destroy();
            await new Promise(resolve => server.close(() => resolve()));
        }
    });
    it('leaves a tunnel alone once the proxy has answered CONNECT in time', async () => {
        const { server, accepted } = await proxy(socket => {
            socket.once('data', () => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
        });
        const req = https.request({
            host: '127.0.0.1',
            port: 443,
            agent: (0, baileys_lifecycle_1.createProxyAgent)(`http://127.0.0.1:${server.address().port}`, 100),
        });
        req.on('error', () => undefined);
        req.end();
        const socket = await accepted;
        try {
            // The handshake that follows through the tunnel goes unanswered, so this socket stays open for
            // as long as nothing closes it; the connect deadline is long past by the time the window ends.
            expect(await closedWithin(socket, 500)).toBe(false);
        }
        finally {
            req.destroy();
            socket.destroy();
            await new Promise(resolve => server.close(() => resolve()));
        }
    });
});
