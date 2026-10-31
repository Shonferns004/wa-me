"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const api_key_dto_1 = require("./api-key.dto");
const auth_service_1 = require("../auth.service");
const property = (dto, name) => Reflect.getMetadata('swagger/apiModelProperties', dto, name);
describe('API key DTO contract', () => {
    it('describes keyPrefix with the length the service stores', async () => {
        const repository = { create: (row) => row, save: (row) => Promise.resolve(row) };
        const service = new auth_service_1.AuthService(repository, {}, {});
        const { apiKey } = await service.createApiKey({ name: 'probe' });
        expect(property(api_key_dto_1.ApiKeyResponseDto.prototype, 'keyPrefix').description).toContain(`First ${apiKey.keyPrefix.length} characters`);
    });
    it('declares null as the way to clear expiresAt, the only empty value validation accepts', async () => {
        expect(property(api_key_dto_1.UpdateApiKeyDto.prototype, 'expiresAt').nullable).toBe(true);
        const errors = async (expiresAt) => (await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(api_key_dto_1.UpdateApiKeyDto, { expiresAt }))).map(error => error.property);
        expect(await errors(null)).toEqual([]);
        expect(await errors('')).toEqual(['expiresAt']);
    });
    it.each([api_key_dto_1.CreateApiKeyDto, api_key_dto_1.UpdateApiKeyDto])('publishes the name length bounds %p validates', dto => {
        expect(property(dto.prototype, 'name')).toEqual(expect.objectContaining({ minLength: 3, maxLength: 100 }));
    });
    // @ArrayMaxSize is runtime-only: a client generated from the schema learns the bound from maxItems or not at all.
    it.each([api_key_dto_1.CreateApiKeyDto, api_key_dto_1.UpdateApiKeyDto])('publishes the allowedChats bound of %p', dto => {
        expect(property(dto.prototype, 'allowedChats').maxItems).toBe(api_key_dto_1.ALLOWED_CHATS_MAX);
    });
    it.each([api_key_dto_1.CreateApiKeyDto, api_key_dto_1.UpdateApiKeyDto])('bounds the allowedChats list of %p', async (dto) => {
        // Search binds one SQL parameter per expanded id and a socket holds at most 4096 rooms, two address
        // forms per phone, so an unbounded list made search answer 500 and every subscribe refuse.
        const errors = async (count) => (await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(dto, {
            name: 'probe',
            allowedChats: Array.from({ length: count }, (_, index) => `62811${String(index).padStart(7, '0')}`),
        }))).map(error => error.property);
        expect(await errors(api_key_dto_1.ALLOWED_CHATS_MAX)).toEqual([]);
        expect(await errors(api_key_dto_1.ALLOWED_CHATS_MAX + 1)).toEqual(['allowedChats']);
    });
    // An empty list is "no restriction" for these three fields, and class-transformer turned an object into an
    // empty list, so a map sent by mistake created a key that reached every chat, session and address.
    it.each([api_key_dto_1.CreateApiKeyDto, api_key_dto_1.UpdateApiKeyDto])('refuses a restriction list of %p given as an object', async (dto) => {
        for (const field of ['allowedChats', 'allowedSessions', 'allowedIps']) {
            for (const value of [{}, { '628111@c.us': true }]) {
                const errors = (await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(dto, { name: 'probe', [field]: value }))).map(e => e.property);
                expect(errors).toEqual([field]);
            }
        }
    });
    it.each([api_key_dto_1.CreateApiKeyDto, api_key_dto_1.UpdateApiKeyDto])('still takes the restriction lists of %p as lists, empty ones too', async (dto) => {
        const body = { name: 'probe', allowedChats: ['628111@c.us'], allowedSessions: [], allowedIps: ['10.0.0.0/8'] };
        expect(await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(dto, body))).toEqual([]);
        expect((0, class_transformer_1.plainToInstance)(dto, body).allowedSessions).toEqual([]);
    });
});
