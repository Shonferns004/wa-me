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
const net = __importStar(require("net"));
const docker_service_1 = require("./docker.service");
/**
 * dockerode sets no timeout. A daemon or socket proxy that accepts the connection and never answers
 * (a firewall dropping packets, a wedged upstream behind docker-socket-proxy) must read as "Docker not
 * available" rather than hold the boot that awaits the ping.
 */
describe('DockerService against a daemon that never answers', () => {
    const sockets = new Set();
    let server;
    let previousHost;
    beforeEach(async () => {
        previousHost = process.env.DOCKER_HOST;
        server = net.createServer(socket => {
            sockets.add(socket);
            socket.on('data', () => undefined);
            socket.on('close', () => sockets.delete(socket));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        process.env.DOCKER_HOST = `tcp://127.0.0.1:${server.address().port}`;
    });
    afterEach(async () => {
        if (previousHost === undefined)
            delete process.env.DOCKER_HOST;
        else
            process.env.DOCKER_HOST = previousHost;
        for (const socket of sockets)
            socket.destroy();
        await new Promise(resolve => server.close(() => resolve()));
    });
    it('boots with Docker unavailable once the ping is not answered in time', async () => {
        const service = new docker_service_1.DockerService();
        service.callTimeoutMs = 150;
        const started = Date.now();
        await service.onModuleInit();
        expect(Date.now() - started).toBeLessThan(2000);
        expect(service.isDockerAvailable()).toBe(false);
    }, 10_000);
    // A call that is only raced against its deadline keeps its request and its socket, and every later
    // availability check starts another one, until the process runs out of descriptors.
    it('closes the connection of every call it gave up on', async () => {
        const service = new docker_service_1.DockerService();
        service.callTimeoutMs = 100;
        await service.onModuleInit();
        for (let i = 0; i < 6; i++) {
            service.isDockerAvailable();
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(sockets.size).toBeLessThanOrEqual(1);
    }, 15_000);
});
