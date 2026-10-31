"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_not_supported_error_1 = require("./engine-not-supported.error");
describe('EngineNotSupportedError', () => {
    it('carries HTTP 501 so NestJS returns Not Implemented without a custom filter', () => {
        expect(new engine_not_supported_error_1.EngineNotSupportedError('getGroups').getStatus()).toBe(501);
    });
    it('names the unsupported operation in the message', () => {
        expect(new engine_not_supported_error_1.EngineNotSupportedError('getGroups').message).toContain('getGroups');
    });
});
