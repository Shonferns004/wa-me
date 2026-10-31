"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const socket_io_1 = require("socket.io");
const ws_1 = __importDefault(require("ws"));
const redis_io_adapter_1 = require("./redis-io.adapter");
/**
 * What matters here is which peers Socket.IO's connect timeout reaps, so this runs a real server and raw
 * Engine.IO frames instead of mocks. The timers are short; the behaviour is the same at the 45 s default.
 */
describe('rejectRootNamespace', () => {
    let httpServer;
    let io;
    let peers;
    beforeEach(async () => {
        peers = [];
        httpServer = (0, node_http_1.createServer)();
        io = new socket_io_1.Server(httpServer, { connectTimeout: 400, pingInterval: 150, pingTimeout: 150 });
        (0, redis_io_adapter_1.rejectRootNamespace)(io);
        io.of('/events');
        await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    });
    afterEach(async () => {
        for (const ws of peers)
            ws.terminate();
        await io.close();
    });
    /** A websocket peer that answers pings like a live client and sends `connect` once the server has opened. */
    const open = (connect) => {
        const { port } = httpServer.address();
        const ws = new ws_1.default(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
        peers.push(ws);
        const frames = [];
        let closed = false;
        ws.on('message', (data) => {
            const frame = data.toString();
            frames.push(frame);
            if (frame === '2')
                ws.send('3');
            if (frame.startsWith('0'))
                ws.send(connect);
        });
        ws.on('close', () => {
            closed = true;
        });
        return { frames, closed: () => closed };
    };
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    it('refuses a CONNECT to the root namespace, so the connect timeout closes the peer', async () => {
        const peer = open('40');
        await wait(250);
        expect(peer.frames.some(frame => frame.startsWith('44') && frame.includes('Invalid namespace'))).toBe(true);
        expect(peer.closed()).toBe(false);
        await wait(500);
        expect(peer.closed()).toBe(true);
    });
    it('still admits a peer that joins /events, and keeps it past the connect timeout', async () => {
        const peer = open('40/events,');
        await wait(250);
        expect(peer.frames.some(frame => frame.startsWith('40/events,'))).toBe(true);
        await wait(500);
        expect(peer.closed()).toBe(false);
    });
});
