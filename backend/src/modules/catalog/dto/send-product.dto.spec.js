"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const send_product_dto_1 = require("./send-product.dto");
const send_message_dto_1 = require("../../message/dto/send-message.dto");
/** The constraints that failed, keyed by property; empty when the payload is valid. */
const failures = async (body) => {
    const errors = await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(send_product_dto_1.SendProductDto, body, { enableImplicitConversion: true }));
    return Object.fromEntries(errors.map(e => [e.property, Object.keys(e.constraints ?? {})]));
};
describe('SendProductDto', () => {
    const valid = { chatId: '628123@c.us', productId: 'prod-1', body: 'Back in stock!' };
    it('accepts a product send with or without a body', async () => {
        expect(await failures(valid)).toEqual({});
        expect(await failures({ chatId: valid.chatId, productId: valid.productId })).toEqual({});
        expect(await failures({ ...valid, body: '' })).toEqual({});
    });
    it('rejects an empty chatId or productId', async () => {
        expect(await failures({ ...valid, chatId: '' })).toEqual({ chatId: ['matches', 'isNotEmpty'] });
        expect(await failures({ ...valid, productId: '' })).toEqual({ productId: ['isNotEmpty'] });
    });
    it('caps the productId length', async () => {
        expect(await failures({ ...valid, productId: 'p'.repeat(send_product_dto_1.PRODUCT_ID_MAX_LENGTH) })).toEqual({});
        expect(await failures({ ...valid, productId: 'p'.repeat(send_product_dto_1.PRODUCT_ID_MAX_LENGTH + 1) })).toEqual({
            productId: ['maxLength'],
        });
    });
    it('caps the body at the text-message limit', async () => {
        expect(await failures({ ...valid, body: 'b'.repeat(send_message_dto_1.MESSAGE_TEXT_MAX_LENGTH) })).toEqual({});
        expect(await failures({ ...valid, body: 'b'.repeat(send_message_dto_1.MESSAGE_TEXT_MAX_LENGTH + 1) })).toEqual({
            body: ['maxLength'],
        });
    });
});
describe('ProductQueryDto', () => {
    // The query string arrives as text and the pipe converts it, so the cases go through the same conversion.
    const queryFailures = async (query) => {
        const errors = await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(send_product_dto_1.ProductQueryDto, query, { enableImplicitConversion: true }));
        return Object.fromEntries(errors.map(e => [e.property, Object.keys(e.constraints ?? {})]));
    };
    const published = (name) => Reflect.getMetadata('swagger/apiModelProperties', send_product_dto_1.ProductQueryDto.prototype, name);
    it('defaults to the first page of 20', () => {
        const query = (0, class_transformer_1.plainToInstance)(send_product_dto_1.ProductQueryDto, {}, { enableImplicitConversion: true });
        expect({ page: query.page, limit: query.limit }).toEqual({ page: 1, limit: 20 });
    });
    it('accepts the first page and a one-item page', async () => {
        expect(await queryFailures({ page: '1', limit: '1' })).toEqual({});
    });
    it('refuses a page or limit below 1, as the contract publishes, and a fractional one', async () => {
        expect(published('page').minimum).toBe(1);
        expect(published('limit').minimum).toBe(1);
        expect(await queryFailures({ page: '0' })).toEqual({ page: ['min'] });
        expect(await queryFailures({ limit: '0' })).toEqual({ limit: ['min'] });
        expect(await queryFailures({ limit: '1.5' })).toEqual({ limit: ['isInt'] });
    });
});
