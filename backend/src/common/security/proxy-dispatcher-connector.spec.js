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
const http = __importStar(require("http"));
const proxy_dispatcher_1 = require("./proxy-dispatcher");
const socks_proxy_servers_1 = require("../../../test/helpers/socks-proxy-servers");
// The connector is private to the dispatcher: undici's Agent receives it as its `connect` option, so the
// Agent is replaced by a recorder that keeps that option and the connector can be called directly.
jest.mock('undici', () => {
    const actual = jest.requireActual('undici');
    return {
        ...actual,
        Agent: jest.fn((options) => ({ connect: options.connect })),
        Dispatcher1Wrapper: jest.fn((dispatcher) => dispatcher),
    };
});
describe('SOCKS connector callback', () => {
    let origin;
    let proxy;
    beforeAll(async () => {
        origin = http.createServer((_req, res) => res.end('ok'));
        await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    });
    afterAll(async () => {
        origin.closeAllConnections();
        await new Promise(resolve => origin.close(() => resolve()));
    });
    afterEach(async () => {
        await proxy?.close();
        proxy = undefined;
    });
    const connectorFor = (url) => (0, proxy_dispatcher_1.createProxyDispatcher)(url).connect;
    const settle = () => new Promise(resolve => setTimeout(resolve, 100));
    // open() answers undici's callback from inside itself, so a throw out of that callback lands in the
    // catch handler of the same promise. Undici's connect callback must still be answered once.
    it('answers once with the socket when the callback throws after it was handed one', async () => {
        proxy = await (0, socks_proxy_servers_1.startSocks5Proxy)({ relayTo: origin.address().port });
        const callback = jest.fn(() => {
            throw new Error('callback failed after the socket was handed over');
        });
        connectorFor(proxy.url)({ hostname: '203.0.113.7', protocol: 'http:', port: '80' }, callback);
        await settle();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][0]).toBeNull();
        callback.mock.calls[0][1]?.destroy();
    });
    it('answers once with the error when no address can be dialled', async () => {
        const callback = jest.fn();
        // A SOCKS4 request has no IPv6 form, so this fails before any connection is made.
        connectorFor('socks4://127.0.0.1:1')({ hostname: '[::1]', protocol: 'http:', port: '80' }, callback);
        await settle();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(callback.mock.calls[0][1]).toBeNull();
    });
});
