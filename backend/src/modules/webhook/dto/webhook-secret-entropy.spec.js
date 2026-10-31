"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const class_validator_1 = require("class-validator");
const webhook_dto_1 = require("./webhook.dto");
/**
 * The HMAC secret signs every delivery this webhook fires. A short secret is recoverable
 * from one observed signature, which turns the signature from an integrity check into a forging
 * tool — 16 characters is the floor, not a recommendation.
 */
describe('CreateWebhookDto secret entropy', () => {
    const dtoWithSecret = (secret) => {
        const dto = new webhook_dto_1.CreateWebhookDto();
        dto.url = 'https://receiver.example.com/hook';
        dto.events = ['message.received'];
        dto.secret = secret;
        return dto;
    };
    it('rejects a secret shorter than 16 characters', async () => {
        const errors = await (0, class_validator_1.validate)(dtoWithSecret('short'));
        expect(errors.some(e => e.property === 'secret')).toBe(true);
    });
    it('accepts a 16+ character secret', async () => {
        const errors = await (0, class_validator_1.validate)(dtoWithSecret('a-fully-entropic-secret'));
        expect(errors.some(e => e.property === 'secret')).toBe(false);
    });
    it('still allows omitting the secret entirely (unsigned webhooks are a valid choice)', async () => {
        const dto = new webhook_dto_1.CreateWebhookDto();
        dto.url = 'https://receiver.example.com/hook';
        dto.events = ['message.received'];
        expect(errorsOf(await (0, class_validator_1.validate)(dto))).toBe(0);
        function errorsOf(errs) {
            return errs.filter(e => e.property === 'secret').length;
        }
    });
});
describe('UpdateWebhookDto secret entropy', () => {
    const dtoWithSecret = (secret) => {
        const dto = new webhook_dto_1.UpdateWebhookDto();
        dto.secret = secret;
        return dto;
    };
    it('rejects rotating to a secret shorter than 16 characters', async () => {
        const errors = await (0, class_validator_1.validate)(dtoWithSecret('short'));
        expect(errors.some(e => e.property === 'secret')).toBe(true);
    });
    it('accepts rotating to a 16+ character secret', async () => {
        const errors = await (0, class_validator_1.validate)(dtoWithSecret('a-fully-entropic-secret'));
        expect(errors.some(e => e.property === 'secret')).toBe(false);
    });
    it('still accepts an empty string, which this route treats as clearing the secret', async () => {
        const errors = await (0, class_validator_1.validate)(dtoWithSecret(''));
        expect(errors.some(e => e.property === 'secret')).toBe(false);
    });
    it('still allows leaving the secret out of the patch entirely', async () => {
        const errors = await (0, class_validator_1.validate)(new webhook_dto_1.UpdateWebhookDto());
        expect(errors.some(e => e.property === 'secret')).toBe(false);
    });
    it('still rejects a non-string value', async () => {
        const errors = await (0, class_validator_1.validate)(dtoWithSecret(42));
        expect(errors.some(e => e.property === 'secret')).toBe(true);
    });
});
/**
 * The example Swagger renders is the body most readers send first, so the floor above has to hold for
 * it too. It did not: the published example was 15 characters, and pasting it back through "Try it
 * out" answered `400` naming a `minLength` the schema never declared, which reads as the API dropping
 * the field rather than refusing it ([#1491](https://github.com/rmyndharis/OpenWA/issues/1491)).
 *
 * Read straight off the decorator rather than restating the value, so an example edited in the DTO is
 * still the one under test.
 */
describe('the documented secret example', () => {
    const exampleOf = (target, property) => Reflect.getMetadata('swagger/apiModelProperties', target, property)?.example;
    it('is published on the create route', () => {
        expect(typeof exampleOf(webhook_dto_1.CreateWebhookDto.prototype, 'secret')).toBe('string');
    });
    // Scoped to `secret` like the suites above: a required field added to this DTO later would fail a
    // whole-object assertion here for a reason that has nothing to do with the example under test.
    it('passes the validation the create route applies to it', async () => {
        const dto = new webhook_dto_1.CreateWebhookDto();
        dto.url = 'https://receiver.example.com/hook';
        dto.events = ['message.received'];
        dto.secret = exampleOf(webhook_dto_1.CreateWebhookDto.prototype, 'secret');
        const errors = await (0, class_validator_1.validate)(dto);
        expect(errors.filter(e => e.property === 'secret')).toEqual([]);
    });
    // The update route publishes no example on purpose (see the DTO), so Swagger renders the generic
    // `"string"` there. That is a `400`, which is the safe way to be wrong on a route that patches a
    // key already in use.
    it('is deliberately absent from the update route', () => {
        expect(exampleOf(webhook_dto_1.UpdateWebhookDto.prototype, 'secret')).toBeUndefined();
    });
});
