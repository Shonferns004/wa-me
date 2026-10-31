"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const message_row_mapper_1 = require("./message-row.mapper");
const msg = (over = {}) => ({ type: 'chat', ...over });
describe('buildMessageMetadata', () => {
    it('returns undefined when there is nothing to store (the column is nullable)', () => {
        expect((0, message_row_mapper_1.buildMessageMetadata)(msg())).toBeUndefined();
    });
    it('stores the engine-supplied media as-is', () => {
        const media = { mimetype: 'image/png', data: 'x' };
        expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ type: 'image', media }))).toEqual({ media });
    });
    it('stores a quoted message', () => {
        const quotedMessage = { id: 'q1' };
        expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ quotedMessage }))).toEqual({ quotedMessage });
    });
    it('stores call metadata', () => {
        const call = { video: false, missed: false };
        expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ call }))).toEqual({ call });
    });
    it('keeps exact poll choices for live, echo, and history rows', () => {
        const poll = { name: 'Where?', options: [' Park ', 'Beach'], allowMultipleAnswers: false };
        expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ type: 'poll', poll }))).toEqual({ poll });
        expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ type: 'poll', poll }), true)).toEqual({ poll });
    });
    it('stores prompt buttons', () => {
        const buttons = [
            { id: 'yes', text: 'Sim' },
            { id: 'no', text: 'Não' },
        ];
        expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ buttons }))).toEqual({ buttons });
    });
    it('ignores an empty buttons array', () => {
        expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ buttons: [] }))).toBeUndefined();
    });
    it('stores every present field together', () => {
        const built = (0, message_row_mapper_1.buildMessageMetadata)(msg({
            type: 'image',
            media: { mimetype: 'image/png' },
            quotedMessage: { id: 'q' },
            call: { video: false, missed: false },
            buttons: [{ id: 'ok', text: 'OK' }],
        }));
        expect(Object.keys(built).sort()).toEqual(['buttons', 'call', 'media', 'quotedMessage']);
    });
    describe('omitted-media synthesis', () => {
        // The history backfill arrives without the payload; without a marker the row renders as an empty
        // bubble and drops out of the by-type stats.
        it.each([...message_row_mapper_1.MEDIA_MESSAGE_TYPES])('synthesizes a placeholder for a media-typed %s when asked', type => {
            expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ type: type }), true)).toEqual({
                media: { mimetype: '', omitted: true },
            });
        });
        it('does NOT synthesize for the live inbound path, where absent media means no media', () => {
            // This is the one deliberate difference between the three persist paths.
            expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ type: 'image' }))).toBeUndefined();
        });
        it('does not synthesize for a non-media type', () => {
            expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ type: 'chat' }), true)).toBeUndefined();
        });
        it('prefers real media over the placeholder', () => {
            const media = { mimetype: 'image/png' };
            expect((0, message_row_mapper_1.buildMessageMetadata)(msg({ type: 'image', media }), true)).toEqual({ media });
        });
        it('returns a fresh placeholder each time, so callers cannot mutate a shared object', () => {
            const a = (0, message_row_mapper_1.buildMessageMetadata)(msg({ type: 'image' }), true);
            const b = (0, message_row_mapper_1.buildMessageMetadata)(msg({ type: 'image' }), true);
            expect(a.media).not.toBe(b.media);
        });
    });
});
describe('storableWaMessageId', () => {
    it('passes a real id through', () => {
        expect((0, message_row_mapper_1.storableWaMessageId)('wa-1')).toBe('wa-1');
    });
    it('maps the empty sentinel to undefined so the row stores NULL', () => {
        // `''` would collide the second unreadable-id message on the (sessionId, waMessageId) unique
        // index and lose the row; NULL is what that index exempts.
        expect((0, message_row_mapper_1.storableWaMessageId)('')).toBeUndefined();
    });
    it('maps undefined to undefined', () => {
        expect((0, message_row_mapper_1.storableWaMessageId)(undefined)).toBeUndefined();
    });
});
