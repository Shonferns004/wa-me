"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const app_validation_1 = require("../../../config/app-validation");
const create_session_dto_1 = require("./create-session.dto");
// docs/06: the session name is 3 to 50 characters of ASCII letters, digits and hyphens.
describe('CreateSessionDto name validation', () => {
    const failing = (name) => (0, class_validator_1.validateSync)((0, class_transformer_1.plainToInstance)(create_session_dto_1.CreateSessionDto, { name }, app_validation_1.GLOBAL_VALIDATION_OPTIONS.transformOptions), app_validation_1.GLOBAL_VALIDATION_OPTIONS).map(error => error.property);
    it.each([
        ['the shortest name, 3 characters', 'abc'],
        ['the longest name, 50 characters', 'a'.repeat(50)],
        ['letters, digits and hyphens', 'My-Bot-01'],
    ])('accepts %s', (_label, name) => {
        expect(failing(name)).toEqual([]);
    });
    it.each([
        ['2 characters', 'ab'],
        ['51 characters', 'a'.repeat(51)],
        ['an empty name', ''],
        ['an underscore', 'my_bot'],
        ['a space', 'my bot'],
        ['a dot', 'my.bot'],
        ['a non-ASCII letter', 'bot-é'],
        ['an object instead of a string', { value: 'abc' }],
    ])('rejects %s', (_label, name) => {
        expect(failing(name)).toEqual(['name']);
    });
    it('rejects a missing name', () => {
        expect(failing(undefined)).toEqual(['name']);
    });
});
describe('CreateSessionDto proxyUrl validation', () => {
    const errs = (proxyUrl) => (0, class_validator_1.validateSync)((0, class_transformer_1.plainToInstance)(create_session_dto_1.CreateSessionDto, { name: 'my-bot', proxyUrl }));
    it.each([
        'http://proxy.example.com:8080',
        'http://user:pass@proxy.example.com:8080',
        'https://proxy.example.com:8443',
        'socks5://proxy.example.com:1080',
        'socks4://proxy.example.com:1080',
        // Single-label hosts are common in containerized setups (e.g. a `squid` service) — must validate.
        'http://localhost:8080',
        'http://squid:3128',
        'socks5://proxy:1080',
        'http://10.0.0.1:8080',
    ])('accepts a valid proxy URL: %s', url => {
        expect(errs(url)).toHaveLength(0);
    });
    it.each([
        'not a url',
        'proxy.example.com:8080', // no scheme
        'ftp://proxy.example.com:21', // unsupported scheme
        'javascript:alert(1)',
    ])('rejects an invalid / non-proxy-scheme proxyUrl: %s', url => {
        expect(errs(url).length).toBeGreaterThan(0);
    });
    it('allows an omitted proxyUrl (optional)', () => {
        expect((0, class_validator_1.validateSync)((0, class_transformer_1.plainToInstance)(create_session_dto_1.CreateSessionDto, { name: 'my-bot' }))).toHaveLength(0);
    });
    // @nestjs/swagger derives no bound from @MaxCodePoints, so the decorator has to state it.
    it('publishes the 255 code point cap', () => {
        const published = Reflect.getMetadata(swagger_1.DECORATORS.API_MODEL_PROPERTIES, create_session_dto_1.CreateSessionDto.prototype, 'proxyUrl');
        expect(published?.maxLength).toBe(255);
    });
});
describe('CreateSessionDto config validation', () => {
    const errs = (config) => (0, class_validator_1.validateSync)((0, class_transformer_1.plainToInstance)(create_session_dto_1.CreateSessionDto, { name: 'my-bot', config }));
    it.each([['abc'], [[1, 2]], [42]])('rejects a config that is not an object: %j', config => {
        expect(errs(config).map(e => e.property)).toEqual(['config']);
    });
    it('accepts an object, unknown keys included (they are stored but ignored)', () => {
        expect(errs({ maxReconnectAttempts: 5, custom: 'x' })).toHaveLength(0);
    });
});
/**
 * The three keys the session reads are held to the same rules as PATCH /config. Stored unvalidated, an
 * out-of-range value was clamped at start time without a word: -1 or 0.5 became 0 and disabled
 * reconnect, and the string "true" left autoRejectCalls off.
 */
describe('CreateSessionDto config keys through the global pipe', () => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const create = (config) => pipe.transform({ name: 'my-bot', config }, { type: 'body', metatype: create_session_dto_1.CreateSessionDto });
    it.each([
        [{ maxReconnectAttempts: -1 }, 'config.maxReconnectAttempts must not be less than 0'],
        [{ maxReconnectAttempts: 0.5 }, 'config.maxReconnectAttempts must be an integer number'],
        [{ maxReconnectAttempts: 50 }, 'config.maxReconnectAttempts must not be greater than 20'],
        [{ reconnectBaseDelay: 500 }, 'config.reconnectBaseDelay must not be less than 1000'],
        [{ autoRejectCalls: 'yes' }, 'config.autoRejectCalls must be a boolean value'],
    ])('refuses %j with a 400 naming the key', async (config, message) => {
        const error = await create(config).then(() => undefined, (e) => e);
        expect(error).toBeInstanceOf(common_1.BadRequestException);
        expect(error.getResponse().message).toEqual([
            expect.stringContaining(message),
        ]);
    });
    it('stores the strict spellings PATCH /config accepts as their typed values', async () => {
        const dto = await create({ autoRejectCalls: 'true', maxReconnectAttempts: '5', reconnectBaseDelay: 2000 });
        expect(dto.config).toEqual({ autoRejectCalls: true, maxReconnectAttempts: 5, reconnectBaseDelay: 2000 });
    });
    it('keeps unknown keys and leaves absent ones absent', async () => {
        const dto = await create({ custom: 'x', maxReconnectAttempts: null });
        expect(dto.config).toEqual({ custom: 'x', maxReconnectAttempts: null });
    });
});
