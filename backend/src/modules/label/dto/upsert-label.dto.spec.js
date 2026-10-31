"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const upsert_label_dto_1 = require("./upsert-label.dto");
const app_validation_1 = require("../../../config/app-validation");
const published = (name) => Reflect.getMetadata('swagger/apiModelProperties', upsert_label_dto_1.UpsertLabelDto.prototype, name);
// The options the global ValidationPipe runs with, so a body is judged the way a request is.
const { transformOptions, ...pipeOptions } = app_validation_1.GLOBAL_VALIDATION_OPTIONS;
/** The constraints that failed, keyed by property; empty when the body is valid. */
const failures = async (body) => {
    const errors = await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(upsert_label_dto_1.UpsertLabelDto, body, transformOptions), pipeOptions);
    return Object.fromEntries(errors.map(e => [e.property, Object.keys(e.constraints ?? {})]));
};
// Each case judges a value at the bound and one past it with the real validator and reads the published
// value beside it, so the contract and the validator cannot drift apart unnoticed.
describe('UpsertLabelDto', () => {
    it('keeps the name between 1 and 100 characters, as the contract publishes', async () => {
        expect(published('name')).toMatchObject({ minLength: 1, maxLength: 100 });
        expect(await failures({ name: 'x' })).toEqual({});
        expect(await failures({ name: 'x'.repeat(100) })).toEqual({});
        expect(await failures({ name: 'x'.repeat(101) })).toEqual({ name: ['maxLength'] });
        expect(await failures({ name: '' })).toEqual({ name: ['minLength'] });
    });
    it('keeps the colour inside the 0-19 palette index, as the contract publishes, and refuses a blank one', async () => {
        expect(published('color')).toMatchObject({ minimum: 0, maximum: 19 });
        expect(await failures({ color: 0 })).toEqual({});
        expect(await failures({ color: 19 })).toEqual({});
        expect(await failures({ color: 20 })).toEqual({ color: ['max'] });
        expect(await failures({ color: -1 })).toEqual({ color: ['min'] });
        // Number('') is 0, a real colour, so a blank field must be refused instead of silently recolouring.
        expect(await failures({ color: '' })).toHaveProperty('color');
    });
    it('lets both fields be omitted or null; whether that is enough to write is a service rule', async () => {
        expect(await failures({})).toEqual({});
        expect(await failures({ name: null, color: null })).toEqual({});
    });
});
