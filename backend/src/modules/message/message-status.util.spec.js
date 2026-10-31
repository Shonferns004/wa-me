"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const message_status_util_1 = require("./message-status.util");
const message_entity_1 = require("./entities/message.entity");
describe('deliveryStatusToMessageStatus', () => {
    it("maps 'failed' to FAILED", () => {
        expect((0, message_status_util_1.deliveryStatusToMessageStatus)('failed')).toBe(message_entity_1.MessageStatus.FAILED);
    });
    it("maps 'delivered' to DELIVERED", () => {
        expect((0, message_status_util_1.deliveryStatusToMessageStatus)('delivered')).toBe(message_entity_1.MessageStatus.DELIVERED);
    });
    it("maps 'read' to READ", () => {
        expect((0, message_status_util_1.deliveryStatusToMessageStatus)('read')).toBe(message_entity_1.MessageStatus.READ);
    });
    it("returns null for 'pending'/'sent' — no upgrade beyond SENT", () => {
        expect((0, message_status_util_1.deliveryStatusToMessageStatus)('pending')).toBeNull();
        expect((0, message_status_util_1.deliveryStatusToMessageStatus)('sent')).toBeNull();
    });
});
describe('deliveryStatusToAck (deprecated legacy ack integer)', () => {
    it('derives the legacy wwebjs-style ack integer from the neutral status', () => {
        expect((0, message_status_util_1.deliveryStatusToAck)('failed')).toBe(-1);
        expect((0, message_status_util_1.deliveryStatusToAck)('pending')).toBe(0);
        expect((0, message_status_util_1.deliveryStatusToAck)('sent')).toBe(1);
        expect((0, message_status_util_1.deliveryStatusToAck)('delivered')).toBe(2);
        expect((0, message_status_util_1.deliveryStatusToAck)('read')).toBe(3);
    });
});
describe('ackStatusTransitionFrom (monotonic delivery-state guard)', () => {
    it('DELIVERED may advance only from PENDING/SENT (never downgrades a READ row)', () => {
        expect((0, message_status_util_1.ackStatusTransitionFrom)(message_entity_1.MessageStatus.DELIVERED)).toEqual([message_entity_1.MessageStatus.PENDING, message_entity_1.MessageStatus.SENT]);
        expect((0, message_status_util_1.ackStatusTransitionFrom)(message_entity_1.MessageStatus.DELIVERED)).not.toContain(message_entity_1.MessageStatus.READ);
    });
    it('READ may advance from PENDING/SENT/DELIVERED', () => {
        expect((0, message_status_util_1.ackStatusTransitionFrom)(message_entity_1.MessageStatus.READ)).toEqual([
            message_entity_1.MessageStatus.PENDING,
            message_entity_1.MessageStatus.SENT,
            message_entity_1.MessageStatus.DELIVERED,
        ]);
    });
    it('FAILED does not clobber an already delivered/read message', () => {
        const from = (0, message_status_util_1.ackStatusTransitionFrom)(message_entity_1.MessageStatus.FAILED);
        expect(from).toEqual([message_entity_1.MessageStatus.PENDING, message_entity_1.MessageStatus.SENT]);
        expect(from).not.toContain(message_entity_1.MessageStatus.DELIVERED);
        expect(from).not.toContain(message_entity_1.MessageStatus.READ);
    });
});
