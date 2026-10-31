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
const timers = __importStar(require("timers/promises"));
const typeorm_1 = require("typeorm");
const shared_connection_1 = require("./shared-connection");
// Fake timers leave timers/promises alone, so the helper's waits are watched here; they still run for real.
jest.mock('timers/promises', () => {
    const actual = jest.requireActual('timers/promises');
    return {
        __esModule: true,
        ...actual,
        setImmediate: jest.fn(actual.setImmediate),
        setTimeout: jest.fn(actual.setTimeout),
    };
});
describe('awaitNoOpenTransaction', () => {
    let db;
    beforeEach(async () => {
        db = await new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' }).initialize();
    });
    afterEach(async () => {
        jest.useRealTimers();
        await db.destroy();
    });
    it('resolves at once where each runner has a connection of its own, or none reports its state', async () => {
        jest.useFakeTimers();
        jest.mocked(timers.setImmediate).mockClear();
        jest.mocked(timers.setTimeout).mockClear();
        await expect((0, shared_connection_1.awaitNoOpenTransaction)({ options: { type: 'postgres' } })).resolves.toBe(true);
        await expect((0, shared_connection_1.awaitNoOpenTransaction)({ options: { type: 'better-sqlite3' } })).resolves.toBe(true);
        expect(timers.setImmediate).not.toHaveBeenCalled();
        expect(timers.setTimeout).not.toHaveBeenCalled();
        // The shared connection does take its turn, so the two checks above watch the waits the helper makes.
        await expect((0, shared_connection_1.awaitNoOpenTransaction)(db)).resolves.toBe(true);
        expect(timers.setImmediate).toHaveBeenCalledTimes(1);
    });
    it('waits for a transaction open on the shared connection to end', async () => {
        const runner = db.createQueryRunner();
        await runner.startTransaction();
        let ended = false;
        setTimeout(() => {
            ended = true;
            void runner.rollbackTransaction();
        }, 30);
        await expect((0, shared_connection_1.awaitNoOpenTransaction)(db)).resolves.toBe(true);
        expect(ended).toBe(true);
    });
    it('gives up with false when the transaction outlasts the bound', async () => {
        const runner = db.createQueryRunner();
        await runner.startTransaction();
        try {
            await expect((0, shared_connection_1.awaitNoOpenTransaction)(db, 20)).resolves.toBe(false);
        }
        finally {
            await runner.rollbackTransaction();
        }
    });
    // TypeORM sets isTransactionActive before its BEGIN and does not clear it when the BEGIN fails.
    it('does not wait on a runner left marked active by a BEGIN that failed', async () => {
        const runner = db.createQueryRunner();
        const connection = db.driver.databaseConnection;
        connection.exec('BEGIN');
        await expect(runner.startTransaction()).rejects.toThrow();
        connection.exec('ROLLBACK');
        expect(runner.isTransactionActive).toBe(true);
        await expect((0, shared_connection_1.awaitNoOpenTransaction)(db, 1000)).resolves.toBe(true);
    });
});
