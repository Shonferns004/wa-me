"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const swagger_1 = require("@nestjs/swagger");
const status_controller_1 = require("../status.controller");
const status_service_1 = require("../status.service");
/**
 * The status media posts take base64 without a mimetype and fall back to the type of the endpoint
 * (image/jpeg, video/mp4, audio/ogg; codecs=opus). The published schema must not tell a client otherwise.
 */
describe('StatusMediaInput in the published API description', () => {
    it('describes the mimetype as optional, with the endpoint default applied when it is omitted', async () => {
        const moduleRef = await testing_1.Test.createTestingModule({
            controllers: [status_controller_1.StatusController],
            providers: [{ provide: status_service_1.StatusService, useValue: {} }],
        }).compile();
        const app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        const document = swagger_1.SwaggerModule.createDocument(app, new swagger_1.DocumentBuilder().build());
        await app.close();
        const schema = document.components?.schemas?.StatusMediaInput;
        expect(schema.properties.base64.description).not.toMatch(/requir/i);
        expect(schema.properties.mimetype.description).not.toMatch(/requir/i);
        expect(schema.properties.mimetype.description).toMatch(/default/i);
    });
});
