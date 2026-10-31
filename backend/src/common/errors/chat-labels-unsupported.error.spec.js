"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chat_labels_unsupported_error_1 = require("./chat-labels-unsupported.error");
describe('ChatLabelsUnsupportedError', () => {
    it('carries HTTP 422 so NestJS returns Unprocessable Entity without a custom filter', () => {
        expect(new chat_labels_unsupported_error_1.ChatLabelsUnsupportedError().getStatus()).toBe(422);
    });
    it('defaults to the Business-account message and accepts an override', () => {
        expect(new chat_labels_unsupported_error_1.ChatLabelsUnsupportedError().message).toContain('WhatsApp Business account');
        expect(new chat_labels_unsupported_error_1.ChatLabelsUnsupportedError('Channels do not support chat labels.').message).toContain('Channels');
    });
});
