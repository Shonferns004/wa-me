"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const request_pairing_code_dto_1 = require("./request-pairing-code.dto");
const errorCount = (phoneNumber) => (0, class_validator_1.validateSync)((0, class_transformer_1.plainToInstance)(request_pairing_code_dto_1.RequestPairingCodeDto, { phoneNumber })).length;
describe('RequestPairingCodeDto (#252)', () => {
    it.each(['628123456789', '12025550123', '447911123456'])('accepts a digits-only number: %s', n => {
        expect(errorCount(n)).toBe(0);
    });
    it.each(['', '+628123456789', '628 123 456', '628-123-456', 'abc123', '12345', '0123456789012345'])('rejects a malformed number: %s', n => {
        expect(errorCount(n)).toBeGreaterThan(0);
    });
});
describe('RequestPairingCodeDto OpenAPI schema', () => {
    it('publishes the same digits-only pattern the validator enforces', () => {
        const meta = Reflect.getMetadata('swagger/apiModelProperties', request_pairing_code_dto_1.RequestPairingCodeDto.prototype, 'phoneNumber');
        expect(meta.pattern).toBe('^[0-9]{6,15}$');
    });
});
