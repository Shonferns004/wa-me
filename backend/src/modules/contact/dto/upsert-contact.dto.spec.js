"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const upsert_contact_dto_1 = require("./upsert-contact.dto");
const app_validation_1 = require("../../../config/app-validation");
const property = (name) => Reflect.getMetadata('swagger/apiModelProperties', upsert_contact_dto_1.UpsertContactDto.prototype, name);
// The options the global ValidationPipe runs with, so a body is judged the way a request is.
const { transformOptions, ...pipeOptions } = app_validation_1.GLOBAL_VALIDATION_OPTIONS;
/** The constraints that failed, keyed by property; empty when the body is valid. */
const failures = async (body) => {
    const errors = await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(upsert_contact_dto_1.UpsertContactDto, body, transformOptions), pipeOptions);
    return Object.fromEntries(errors.map(e => [e.property, Object.keys(e.constraints ?? {})]));
};
const MAX = upsert_contact_dto_1.ADDRESSBOOK_NAME_MAX_LENGTH;
// The validator refuses an empty first name and caps both names; the contract has to publish the same bounds,
// or a generated client accepts input the server then refuses (or the server saves a nameless addressbook
// entry). Each case judges a value at the bound and one past it with the real validator, and reads the
// published value, so neither side can drift without a failure.
describe('UpsertContactDto contract', () => {
    it('publishes the firstName length bounds the validator enforces', async () => {
        expect(property('firstName')).toMatchObject({ minLength: 1, maxLength: MAX });
        expect(await failures({ firstName: '' })).toEqual({ firstName: ['minLength'] });
        expect(await failures({ firstName: 'x' })).toEqual({});
        expect(await failures({ firstName: 'x'.repeat(MAX) })).toEqual({});
        expect(await failures({ firstName: 'x'.repeat(MAX + 1) })).toEqual({ firstName: ['maxLength'] });
    });
    it('publishes the lastName cap the validator enforces, and lets it be omitted', async () => {
        expect(property('lastName')).toMatchObject({ maxLength: MAX });
        expect(await failures({ firstName: 'Ann' })).toEqual({});
        expect(await failures({ firstName: 'Ann', lastName: 'x'.repeat(MAX) })).toEqual({});
        expect(await failures({ firstName: 'Ann', lastName: 'x'.repeat(MAX + 1) })).toEqual({ lastName: ['maxLength'] });
    });
});
