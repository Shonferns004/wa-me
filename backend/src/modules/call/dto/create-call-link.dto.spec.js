"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const create_call_link_dto_1 = require("./create-call-link.dto");
const app_validation_1 = require("../../../config/app-validation");
describe('CreateCallLinkDto', () => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const through = (value) => pipe.transform(value, { type: 'body', metatype: create_call_link_dto_1.CreateCallLinkDto });
    // Past the largest valid JS Date, whatsapp-web.js builds an Invalid Date and Baileys an
    // exponent-notation start time, so the request must stop here with a 400.
    it.each([8_640_000_000_000_001, 1e16, 1e300])('rejects startTime %d with a 400', async (startTime) => {
        await expect(through({ type: 'video', startTime })).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    // The global pipe converts by declared type, so a boolean would otherwise read as the number 1.
    it.each([true, false, '', ' ', 'soon'])('rejects startTime %p with a 400', async (startTime) => {
        await expect(through({ type: 'video', startTime })).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    it('accepts a start time sent as a numeric string', async () => {
        await expect(through({ type: 'video', startTime: '1800000000000' })).resolves.toEqual({
            type: 'video',
            startTime: 1_800_000_000_000,
        });
    });
    it('accepts the largest valid Date', async () => {
        await expect(through({ type: 'video', startTime: 8_640_000_000_000_000 })).resolves.toEqual({
            type: 'video',
            startTime: 8_640_000_000_000_000,
        });
    });
});
