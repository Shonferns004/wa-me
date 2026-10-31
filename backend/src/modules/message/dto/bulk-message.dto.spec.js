"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const app_validation_1 = require("../../../config/app-validation");
const bulk_message_dto_1 = require("./bulk-message.dto");
const send_message_dto_1 = require("./send-message.dto");
// The production pipe, built from the options main.ts uses, so these cases cannot assert a contract
// the running app does not apply (restated options left out implicit conversion). Its whitelist +
// forbidNonWhitelisted strip/reject unknown props. Before the nested media objects were typed DTOs
// they were bare object literals, so these options could not reach inside a media object — junk in
// `content.image` passed straight through and was persisted verbatim.
const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
const validateBulk = (obj) => pipe.transform(obj, { type: 'body', metatype: bulk_message_dto_1.SendBulkMessageDto });
const accepts = (obj) => expect(validateBulk(obj)).resolves.toBeInstanceOf(bulk_message_dto_1.SendBulkMessageDto);
const rejects = (obj) => expect(validateBulk(obj)).rejects.toBeInstanceOf(common_1.BadRequestException);
const imageItem = (image) => ({
    messages: [{ chatId: 'c@c.us', type: 'image', content: { image } }],
});
describe('SendBulkMessageDto nested media validation', () => {
    it('accepts a well-formed base64 media object', async () => {
        await accepts(imageItem({ base64: 'AAAA', mimetype: 'image/png' }));
    });
    it('rejects an unknown property inside a media object', async () => {
        await rejects(imageItem({ base64: 'AAAA', evil: 'x' }));
    });
    // Implicit conversion turns a number into its string form before @IsString runs, so the service
    // receives a string either way.
    it('converts a numeric base64 inside a media object to a string', async () => {
        const dto = await validateBulk(imageItem({ base64: 12345 }));
        expect(dto.messages[0].content.image?.base64).toBe('12345');
    });
    it.each([[true], [{ a: 1 }]])('refuses %j where a media string belongs', async (value) => {
        await rejects(imageItem({ base64: value }));
        await rejects(imageItem({ url: value }));
        await rejects(imageItem({ base64: 'AAAA', mimetype: value }));
    });
});
const textItem = (text, extra = {}) => ({
    messages: [{ chatId: 'c@c.us', type: 'text', content: { text }, ...extra }],
});
describe('SendBulkMessageDto content length + variables validation', () => {
    it('accepts text at the 4096 cap and rejects beyond it (parity with single-send)', async () => {
        await accepts(textItem('a'.repeat(4096)));
        await rejects(textItem('a'.repeat(4097)));
    });
    it('accepts an object variables map and rejects a non-object', async () => {
        await accepts(textItem('hi', { variables: { name: 'Alice' } }));
        await rejects(textItem('hi', { variables: 'oops' }));
        await rejects(textItem('hi', { variables: [1, 2, 3] }));
    });
});
describe('SendBulkMessageDto recipient', () => {
    it('rejects an empty chatId', async () => {
        await accepts(textItem('hi'));
        await rejects({ messages: [{ chatId: '', type: 'text', content: { text: 'hi' } }] });
    });
});
describe('SendBulkMessageDto personalized mentions', () => {
    it.each(['{{phone}}', '{phone}', '{{ phone }}'])('accepts a mention supplied by %s', async (placeholder) => {
        await accepts({
            messages: [
                {
                    chatId: '120363000000000000@g.us',
                    type: 'text',
                    content: { text: 'Hi @{{phone}}', mentions: [`${placeholder}@c.us`] },
                    variables: { phone: '62811' },
                },
            ],
        });
    });
    it('still rejects a malformed literal mention', async () => {
        await rejects({
            messages: [
                {
                    chatId: '120363000000000000@g.us',
                    type: 'text',
                    content: { text: 'Hi', mentions: ['not-a-person@c.us'] },
                },
            ],
        });
    });
});
// The url scheme is checked by the service after `variables` are applied, because a placeholder may
// stand for the whole URL; the DTO only requires a string.
describe('SendBulkMessageDto media url', () => {
    it('leaves a templated url to the per-item check', async () => {
        await accepts(imageItem({ url: '{{imageUrl}}' }));
        await accepts(imageItem({ url: 'https://{{host}}/a.jpg' }));
    });
    // Converted like any string field; the per-item check then refuses '123' as not an http(s) URL.
    it('converts a numeric url next to base64 to a string', async () => {
        const dto = await validateBulk(imageItem({ base64: 'AAAA', url: 123 }));
        expect(dto.messages[0].content.image?.url).toBe('123');
    });
    // A boolean or an object is refused even next to base64, which wins when the item is sent.
    it.each([[true], [{ a: 1 }]])('refuses %j as the url next to base64', async (value) => {
        await rejects(imageItem({ base64: 'AAAA', url: value }));
    });
});
// @ValidateNested checks an array element by element, so a nested object sent as an array passed. The
// service then read its fields off the array: options [{...}] was stored as the defaults with the caller's
// values dropped, and a media object in an array was only refused later, with a message about the text.
describe('SendBulkMessageDto nested objects refuse an array', () => {
    const options = { delayBetweenMessages: 60000, randomizeDelay: false, stopOnError: true };
    it('accepts the options as an object', async () => {
        await accepts({ ...textItem('hi'), options });
    });
    it.each([[[]], [[{}]], [[options]]])('refuses options given as an array: %j', async (value) => {
        await rejects({ ...textItem('hi'), options: value });
    });
    it('refuses a message content given as an array', async () => {
        await rejects({ messages: [{ chatId: 'c@c.us', type: 'text', content: [{ text: 'hi' }] }] });
    });
    it.each(['image', 'video', 'audio', 'document'])('refuses %s given as an array', async (kind) => {
        await rejects({ messages: [{ chatId: 'c@c.us', type: kind, content: { [kind]: [{ base64: 'AAAA' }] } }] });
    });
});
// @nestjs/swagger does not derive bounds from the validators, so the published schema has to declare
// them itself, or a client generated from it accepts arrays the server answers with a 400.
describe('SendBulkMessageDto published schema', () => {
    const published = (dto, key) => Reflect.getMetadata(swagger_1.DECORATORS.API_MODEL_PROPERTIES, dto, key);
    it('publishes the batch size cap', () => {
        expect(published(bulk_message_dto_1.SendBulkMessageDto.prototype, 'messages')?.maxItems).toBe(bulk_message_dto_1.BULK_MESSAGES_MAX);
    });
    it('publishes the mention list bounds', () => {
        expect(published(bulk_message_dto_1.BulkMessageContentDto.prototype, 'mentions')).toMatchObject({
            maxItems: send_message_dto_1.MENTIONS_MAX,
            items: { type: 'string', maxLength: send_message_dto_1.MENTION_WID_MAX_LENGTH },
        });
    });
});
