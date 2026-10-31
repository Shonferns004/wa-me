"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const health_controller_1 = require("./health.controller");
const health_response_dto_1 = require("./dto/health-response.dto");
const shutdown_service_1 = require("../../common/services/shutdown.service");
const auth_service_1 = require("../auth/auth.service");
const audit_service_1 = require("../audit/audit.service");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
describe('HealthController', () => {
    let controller;
    const mainQuery = jest.fn();
    const dataQuery = jest.fn();
    const isShuttingDown = jest.fn();
    const validateApiKey = jest.fn();
    const logWarn = jest.fn().mockResolvedValue(null);
    const reqWith = (headers = {}, ip = '127.0.0.1') => ({ method: 'GET', path: '/api/health', headers, socket: { remoteAddress: ip } });
    beforeEach(async () => {
        mainQuery.mockResolvedValue([{ '1': 1 }]);
        dataQuery.mockResolvedValue([{ '1': 1 }]);
        isShuttingDown.mockReturnValue(false);
        const module = await testing_1.Test.createTestingModule({
            controllers: [health_controller_1.HealthController],
            providers: [
                { provide: (0, typeorm_1.getDataSourceToken)('main'), useValue: { query: mainQuery } },
                { provide: (0, typeorm_1.getDataSourceToken)('data'), useValue: { query: dataQuery } },
                { provide: shutdown_service_1.ShutdownService, useValue: { isShuttingDown } },
                { provide: auth_service_1.AuthService, useValue: { validateApiKey } },
                { provide: audit_service_1.AuditService, useValue: { logWarn } },
                { provide: config_1.ConfigService, useValue: { get: () => undefined } },
            ],
        }).compile();
        controller = module.get(health_controller_1.HealthController);
    });
    afterEach(() => {
        mainQuery.mockReset();
        dataQuery.mockReset();
        isShuttingDown.mockReset();
        validateApiKey.mockReset();
        logWarn.mockClear(); // keep the resolved value, drop cross-test call history
    });
    describe('check', () => {
        it('returns ok with a timestamp (static)', async () => {
            const result = await controller.check(reqWith());
            expect(result.status).toBe('ok');
            expect(result.timestamp).toBeDefined();
        });
        it('omits the version for an unauthenticated caller and never touches the key store', async () => {
            const result = await controller.check(reqWith());
            expect(result).not.toHaveProperty('version');
            expect(validateApiKey).not.toHaveBeenCalled();
        });
        it('omits the version when the presented key is invalid (the check itself still answers ok)', async () => {
            validateApiKey.mockRejectedValue(new common_1.UnauthorizedException('Invalid API key'));
            const result = await controller.check(reqWith({ 'x-api-key': 'wrong' }));
            expect(result.status).toBe('ok');
            expect(result).not.toHaveProperty('version');
        });
        it('reports the running version to a valid API key (X-API-Key header)', async () => {
            validateApiKey.mockResolvedValue({ id: 'k1' });
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { version } = require('../../../package.json');
            const result = await controller.check(reqWith({ 'x-api-key': 'good-key' }));
            expect(result.version).toBe(version);
            expect(validateApiKey).toHaveBeenCalledWith('good-key', '127.0.0.1');
        });
        it('accepts a Bearer token the same way the guard does', async () => {
            validateApiKey.mockResolvedValue({ id: 'k1' });
            const result = await controller.check(reqWith({ authorization: 'Bearer good-key' }));
            expect(result.version).toBeDefined();
            expect(validateApiKey).toHaveBeenCalledWith('good-key', '127.0.0.1');
        });
        // The auth scheme is case-insensitive (RFC 7235), and the REST guard, Bull Board and MCP already
        // read it that way; an exact 'Bearer ' match here withheld the version from the same valid key.
        it.each(['bearer good-key', 'BEARER good-key'])('accepts the scheme in any case (%s)', async (header) => {
            validateApiKey.mockResolvedValue({ id: 'k1' });
            const result = await controller.check(reqWith({ authorization: header }));
            expect(result.version).toBeDefined();
            expect(validateApiKey).toHaveBeenCalledWith('good-key', '127.0.0.1');
        });
    });
    describe('key-probe auditing', () => {
        it('audits a presented-but-invalid key like every other key-validation surface', async () => {
            validateApiKey.mockRejectedValue(new common_1.UnauthorizedException('Invalid API key'));
            const result = await controller.check(reqWith({ 'x-api-key': 'owa_k1_probe' }));
            expect(result.status).toBe('ok'); // the probe itself never fails
            expect(result).not.toHaveProperty('version');
            expect(logWarn).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.API_KEY_AUTH_FAILED, {
                ipAddress: '127.0.0.1',
                method: 'GET',
                path: '/api/health',
                errorMessage: 'Invalid API key',
            });
        });
        it('does not audit an absent key (uptime probes stay free of audit noise)', async () => {
            await controller.check(reqWith());
            expect(logWarn).not.toHaveBeenCalled();
        });
        it('does not audit a valid key', async () => {
            validateApiKey.mockResolvedValue({ id: 'k1' });
            await controller.check(reqWith({ 'x-api-key': 'owa_k1_valid' }));
            expect(logWarn).not.toHaveBeenCalled();
        });
        it('bounds the audit writes per source IP so a probe flood cannot fill the audit log', async () => {
            validateApiKey.mockRejectedValue(new common_1.UnauthorizedException('Invalid API key'));
            for (let i = 0; i < 15; i++) {
                await controller.check(reqWith({ 'x-api-key': `owa_k1_probe_${i}` }));
            }
            expect(logWarn).toHaveBeenCalledTimes(10);
        });
    });
    describe('key-probe audit bound for IPv6', () => {
        it('shares one audit budget across a /64 and records the full address', async () => {
            validateApiKey.mockRejectedValue(new common_1.UnauthorizedException('Invalid API key'));
            for (let i = 0; i < 15; i++) {
                await controller.check(reqWith({ 'x-api-key': 'owa_k1_probe' }, `2001:db8:1:2::${(i + 1).toString(16)}`));
            }
            expect(logWarn).toHaveBeenCalledTimes(10);
            expect(logWarn).toHaveBeenLastCalledWith(audit_log_entity_1.AuditAction.API_KEY_AUTH_FAILED, expect.objectContaining({ ipAddress: '2001:db8:1:2::a' }));
            await controller.check(reqWith({ 'x-api-key': 'owa_k1_probe' }, '2001:db8:1:3::1'));
            expect(logWarn).toHaveBeenCalledTimes(11);
        });
    });
    describe('key-validation budget', () => {
        const presented = (ip) => reqWith({ 'x-api-key': 'owa_k1_probe' }, ip);
        it('stops looking up keys for a client after 30 failed presentations a minute', async () => {
            validateApiKey.mockRejectedValue(new common_1.UnauthorizedException('Invalid API key'));
            for (let i = 0; i < 35; i++) {
                const result = await controller.check(presented());
                expect(result.status).toBe('ok');
                expect(result).not.toHaveProperty('version');
            }
            expect(validateApiKey).toHaveBeenCalledTimes(30);
        });
        it('keeps a separate budget per client, shared across one IPv6 /64', async () => {
            validateApiKey.mockRejectedValue(new common_1.UnauthorizedException('Invalid API key'));
            for (let i = 0; i < 35; i++)
                await controller.check(presented());
            await controller.check(presented('192.0.2.9'));
            expect(validateApiKey).toHaveBeenCalledTimes(31);
            validateApiKey.mockClear();
            for (let i = 0; i < 35; i++)
                await controller.check(presented(`2001:db8:1:2::${(i + 1).toString(16)}`));
            expect(validateApiKey).toHaveBeenCalledTimes(30);
            await controller.check(presented('2001:db8:1:3::1'));
            expect(validateApiKey).toHaveBeenCalledTimes(31);
        });
        it('never spends the budget on a key that validates', async () => {
            validateApiKey.mockResolvedValue({ id: 'k1' });
            for (let i = 0; i < 40; i++) {
                expect((await controller.check(presented())).version).toBeDefined();
            }
            expect(validateApiKey).toHaveBeenCalledTimes(40);
        });
        it('does not charge keyless probes', async () => {
            for (let i = 0; i < 40; i++)
                await controller.check(reqWith());
            validateApiKey.mockRejectedValue(new common_1.UnauthorizedException('Invalid API key'));
            await controller.check(presented());
            expect(validateApiKey).toHaveBeenCalledTimes(1);
        });
    });
    describe('liveness', () => {
        it('returns ok (static — does not probe dependencies)', () => {
            expect(controller.liveness().status).toBe('ok');
        });
    });
    describe('readiness', () => {
        it('returns ok when both databases respond', async () => {
            const result = await controller.readiness();
            expect(result.status).toBe('ok');
            expect(result.details.mainDatabase.status).toBe('up');
            expect(result.details.dataDatabase.status).toBe('up');
            expect(mainQuery).toHaveBeenCalledWith('SELECT 1');
            expect(dataQuery).toHaveBeenCalledWith('SELECT 1');
        });
        /** Runs readiness() and returns the 503 body it threw. */
        const unavailableBody = async (pending = controller.readiness()) => {
            const err = await pending.catch((e) => e);
            expect(err).toBeInstanceOf(common_1.ServiceUnavailableException);
            return err.getResponse();
        };
        it('throws 503 when the data database is down', async () => {
            dataQuery.mockRejectedValue(new Error('connection refused'));
            expect(await unavailableBody()).toEqual({
                status: 'error',
                details: { mainDatabase: { status: 'up' }, dataDatabase: { status: 'down' } },
            });
        });
        it('throws 503 when the main (auth/audit) database is down', async () => {
            mainQuery.mockRejectedValue(new Error('disk I/O error'));
            expect(await unavailableBody()).toEqual({
                status: 'error',
                details: { mainDatabase: { status: 'down' }, dataDatabase: { status: 'up' } },
            });
        });
        it('reports a database whose probe hangs as down after 3 s instead of stalling', async () => {
            jest.useFakeTimers();
            try {
                mainQuery.mockReturnValue(new Promise(() => { }));
                const pending = unavailableBody();
                await jest.advanceTimersByTimeAsync(3000);
                expect(await pending).toEqual({
                    status: 'error',
                    details: { mainDatabase: { status: 'down' }, dataDatabase: { status: 'up' } },
                });
            }
            finally {
                jest.useRealTimers();
            }
        });
        it('throws 503 while draining, without even probing the DBs', async () => {
            isShuttingDown.mockReturnValue(true);
            expect(await unavailableBody()).toEqual({ status: 'error', details: { shutdown: { status: 'draining' } } });
            expect(mainQuery).not.toHaveBeenCalled();
            expect(dataQuery).not.toHaveBeenCalled();
        });
        // The draining 503 answers while every database is up, so the contract must not describe the
        // status as a dependency outage only.
        it('documents both 503 causes with the readiness body shape', () => {
            const responses = Reflect.getMetadata('swagger/apiResponse', Object.getOwnPropertyDescriptor(health_controller_1.HealthController.prototype, 'readiness')?.value);
            expect(responses['503'].description).toContain('draining');
            expect(responses['503'].type).toBe(health_response_dto_1.ReadinessResponseDto);
        });
    });
});
