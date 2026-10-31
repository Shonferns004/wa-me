"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUEUE_NAMES = void 0;
// Queue names used across the application
// Extracted to separate file to avoid circular dependency with processors
exports.QUEUE_NAMES = {
    WEBHOOK: 'webhook-queue',
    INGRESS: 'ingress-queue',
};
