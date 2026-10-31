"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const template_dto_1 = require("./template.dto");
const app_validation_1 = require("../../../config/app-validation");
describe('UpdateTemplateDto', () => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const through = (value) => pipe.transform(value, { type: 'body', metatype: template_dto_1.UpdateTemplateDto });
    it('accepts a partial update that leaves name and body out', async () => {
        await expect(through({ footer: 'bye' })).resolves.toMatchObject({ footer: 'bye' });
    });
    // name and body are NOT NULL columns: an explicit null that passed validation reached save() and
    // answered 500.
    it.each(['name', 'body'])('rejects an explicit null %s', async (field) => {
        await expect(through({ [field]: null })).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    // header and footer are nullable columns, and @IsOptional skips null as well as undefined, so an
    // explicit null reaches update() and clears the stored value. docs/06 documents that; pin it here
    // so the table and the behaviour cannot drift apart.
    it.each(['header', 'footer'])('accepts an explicit null %s, which clears the stored value', async (field) => {
        await expect(through({ [field]: null })).resolves.toEqual({ [field]: null });
    });
});
// The name column is varchar(100), which PostgreSQL counts in code points. A length check that folds
// a presentation selector (U+FE0F) into the character before it let 200 code points through, and the
// INSERT then failed as a 500.
describe('template name length', () => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const emoji = '\u2714\uFE0F';
    it.each([
        ['create', template_dto_1.CreateTemplateDto, { body: 'hi' }],
        ['update', template_dto_1.UpdateTemplateDto, {}],
    ])('%s counts the name in code points', async (_label, metatype, rest) => {
        const through = (name) => pipe.transform({ ...rest, name }, { type: 'body', metatype });
        await expect(through(emoji.repeat(100))).rejects.toBeInstanceOf(common_1.BadRequestException);
        await expect(through(emoji.repeat(50))).resolves.toMatchObject({ name: emoji.repeat(50) });
        await expect(through('a'.repeat(100))).resolves.toMatchObject({ name: 'a'.repeat(100) });
        await expect(through('a'.repeat(101))).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
});
// PostgreSQL text and varchar columns cannot hold U+0000, so a value carrying one passed validation and
// then failed the INSERT or UPDATE as a 500.
describe('template text fields', () => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const valid = { name: 'welcome', body: 'hi', header: 'top', footer: 'bottom' };
    it.each([
        ['create', template_dto_1.CreateTemplateDto],
        ['update', template_dto_1.UpdateTemplateDto],
    ])('%s rejects a NUL character in any text field', async (_label, metatype) => {
        for (const field of ['name', 'body', 'header', 'footer']) {
            await expect(pipe.transform({ ...valid, [field]: 'a\u0000b' }, { type: 'body', metatype })).rejects.toBeInstanceOf(common_1.BadRequestException);
        }
        await expect(pipe.transform(valid, { type: 'body', metatype })).resolves.toMatchObject(valid);
    });
});
