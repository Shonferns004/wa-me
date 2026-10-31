"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const instance_dto_1 = require("./instance.dto");
const app_validation_1 = require("../../../config/app-validation");
describe('UpdateInstanceDto', () => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const through = (value) => pipe.transform(value, { type: 'body', metatype: instance_dto_1.UpdateInstanceDto });
    // Omitting sessionScope leaves it unchanged, so null is the only way to return a bound instance to
    // all sessions. It must reach the service as null, not as a string.
    it('accepts sessionScope null, which resets the instance to all sessions', async () => {
        await expect(through({ sessionScope: null })).resolves.toEqual({ sessionScope: null });
    });
    // plugin_instances.enabled is NOT NULL: a null that got past validation reached save() and answered 500.
    it('rejects enabled: null with a 400', async () => {
        await expect(through({ enabled: null })).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    it('still rejects an empty sessionScope', async () => {
        await expect(through({ sessionScope: '' })).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    // Generated clients read the published schema, so it has to say null is allowed and what it means.
    it('publishes sessionScope as a nullable string that null resets to all sessions', () => {
        const property = Reflect.getMetadata(swagger_1.DECORATORS.API_MODEL_PROPERTIES, instance_dto_1.UpdateInstanceDto.prototype, 'sessionScope');
        expect(property?.nullable).toBe(true);
        expect(property?.type).toBe(String);
        expect(property?.description).toMatch(/null/);
    });
});
const published = (dto, key) => Reflect.getMetadata(swagger_1.DECORATORS.API_MODEL_PROPERTIES, dto, key);
describe('CreateInstanceDto published schema', () => {
    // @nestjs/swagger does not derive bounds from the validators, so each one is declared explicitly.
    it('publishes the bounds the validators enforce', () => {
        const proto = instance_dto_1.CreateInstanceDto.prototype;
        expect(published(proto, 'instanceId')?.pattern).toBe('^[a-zA-Z0-9_-]{1,64}$');
        expect(published(proto, 'sessionScope')).toMatchObject({ minLength: 1, maxLength: 256 });
        expect(published(proto, 'verifyToken')?.maxLength).toBe(512);
        expect(published(proto, 'secret')).toMatchObject({ minLength: 16, maxLength: 512 });
        expect(published(instance_dto_1.UpdateInstanceDto.prototype, 'sessionScope')).toMatchObject({ minLength: 1, maxLength: 256 });
    });
    it('describes the secret mask the API actually returns', () => {
        expect(published(instance_dto_1.CreateInstanceDto.prototype, 'secret')?.description).toContain("Masked ('***')");
    });
});
