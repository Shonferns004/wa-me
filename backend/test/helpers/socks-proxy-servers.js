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
exports.startSocks5Proxy = startSocks5Proxy;
exports.startSocks4Proxy = startSocks4Proxy;
const net = __importStar(require("net"));
const listen = async (server) => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
};
/**
 * Read exactly `size` bytes. Pull-based (`readable` + `read(size)`) rather than a 'data' listener:
 * a handshake field can arrive in the same packet as the next one, and the stream's own buffer keeps
 * the remainder for the next call. Flowing mode would hand over whole packets and lose the tail.
 */
function read(socket, size) {
    return new Promise((resolve, reject) => {
        const settle = (finish) => {
            socket.off('readable', attempt);
            socket.off('error', onError);
            socket.off('end', onEnd);
            finish();
        };
        const attempt = () => {
            const chunk = socket.read(size);
            if (chunk)
                settle(() => resolve(chunk));
        };
        const onError = (error) => settle(() => reject(error));
        const onEnd = () => settle(() => reject(new Error('socks client closed mid-handshake')));
        socket.on('readable', attempt);
        socket.once('error', onError);
        socket.once('end', onEnd);
        attempt();
    });
}
/** Read a length-prefixed byte string (one length octet, then that many bytes). */
async function readLengthPrefixed(socket) {
    const [length] = await read(socket, 1);
    return length === 0 ? '' : (await read(socket, length)).toString();
}
/** Read a NUL-terminated string one byte at a time (the SOCKS4 user id). */
async function readNulTerminated(socket) {
    const bytes = [];
    for (;;) {
        const [byte] = await read(socket, 1);
        if (byte === 0)
            return Buffer.from(bytes).toString();
        bytes.push(byte);
    }
}
function relay(socket, state, relayTo) {
    if (relayTo === undefined) {
        socket.end();
        return;
    }
    const upstream = net.connect(relayTo, '127.0.0.1', () => {
        let first = true;
        socket.on('data', chunk => {
            if (!first)
                return;
            first = false;
            state.firstBytes.push(chunk.subarray(0, 3).toString('hex'));
        });
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
}
function serve(handshake) {
    const state = { destinations: [], credentials: [], firstBytes: [] };
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
        void handshake(socket, state).catch(() => socket.destroy());
    });
    // Destroy live tunnels on close so a spec cannot hang on a half-open relay.
    const close = server.close.bind(server);
    server.close = (cb) => {
        sockets.forEach(socket => socket.destroy());
        return close(cb);
    };
    return { server, state };
}
const finish = async (server, state, url) => {
    const port = await listen(server);
    return {
        url: url(port),
        ...state,
        close: () => new Promise(resolve => server.close(() => resolve())),
    };
};
/** A SOCKS5 proxy, optionally demanding username/password authentication. */
async function startSocks5Proxy(options = {}) {
    const { server, state } = serve(async (socket, recorded) => {
        const [, methodCount] = await read(socket, 2);
        await read(socket, methodCount);
        if (options.credentials) {
            socket.write(Buffer.from([0x05, 0x02])); // username/password
            await read(socket, 1); // auth version
            const username = await readLengthPrefixed(socket);
            const password = await readLengthPrefixed(socket);
            recorded.credentials.push(`${username}:${password}`);
            const ok = username === options.credentials.username && password === options.credentials.password;
            socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
            if (!ok) {
                socket.end();
                return;
            }
        }
        else {
            socket.write(Buffer.from([0x05, 0x00])); // no authentication required
        }
        const request = await read(socket, 4); // ver, cmd, rsv, atyp
        const atyp = request[3];
        let host;
        if (atyp === 0x01) {
            host = [...(await read(socket, 4))].join('.');
        }
        else if (atyp === 0x03) {
            host = await readLengthPrefixed(socket);
        }
        else {
            const raw = await read(socket, 16);
            host = Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(':');
        }
        const port = (await read(socket, 2)).readUInt16BE(0);
        recorded.destinations.push(`${host}:${port}`);
        if (options.ipv4Only && atyp === 0x04) {
            socket.end(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // host unreachable
            return;
        }
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        relay(socket, recorded, options.relayTo);
    });
    const scheme = options.credentials
        ? `socks5://${encodeURIComponent(options.credentials.username)}:${encodeURIComponent(options.credentials.password)}@127.0.0.1:`
        : 'socks5://127.0.0.1:';
    return finish(server, state, port => `${scheme}${port}`);
}
/** A strict SOCKS4 proxy: an IPv4 destination only, and no authentication step at all. */
async function startSocks4Proxy(options = {}) {
    const { server, state } = serve(async (socket, recorded) => {
        const request = await read(socket, 8); // ver, cmd, port(2), ip(4)
        const port = request.readUInt16BE(2);
        const host = [...request.subarray(4, 8)].join('.');
        recorded.credentials.push(await readNulTerminated(socket)); // user id, the only identity SOCKS4 has
        recorded.destinations.push(`${host}:${port}`);
        socket.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0])); // request granted
        relay(socket, recorded, options.relayTo);
    });
    return finish(server, state, port => `socks4://127.0.0.1:${port}`);
}
