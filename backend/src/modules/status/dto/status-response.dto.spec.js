"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const swagger_1 = require("@nestjs/swagger");
const status_response_dto_1 = require("./status-response.dto");
// The GET status routes answer from the status store (StatusStoreService.toStatus), not the engine, so
// the published schema must describe that shape: a gateway media path, and no inline media bytes.
describe('StatusDto', () => {
    const property = (name) => Reflect.getMetadata(swagger_1.DECORATORS.API_MODEL_PROPERTIES, status_response_dto_1.StatusDto.prototype, name);
    it('does not advertise a media field the store never returns', () => {
        expect(property('media')).toBeUndefined();
    });
    it('describes mediaUrl as the authenticated gateway media route', () => {
        expect(property('mediaUrl')?.description).toMatch(/\/sessions\/\{sessionId\}\/status\/\{statusId\}\/media/);
        expect(property('mediaUrl')?.description).toMatch(/X-API-Key/);
    });
});
