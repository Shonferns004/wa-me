"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileService = void 0;
const common_1 = require("@nestjs/common");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const media_cap_util_1 = require("../message/media-cap.util");
/**
 * Owns engine access for own-profile operations. Thin pass-throughs behind the same
 * "session not started" guard as the other session-scoped services (see GroupService).
 */
let ProfileService = class ProfileService {
    engines;
    constructor(engines) {
        this.engines = engines;
    }
    getEngine(sessionId) {
        // EngineRegistry.require()'s default is this exact 400 "Session is not started".
        return this.engines.require(sessionId);
    }
    setProfileName(sessionId, name) {
        return this.getEngine(sessionId).setProfileName(name);
    }
    setProfileStatus(sessionId, status) {
        return this.getEngine(sessionId).setProfileStatus(status);
    }
    /** Remove the account's own picture. Idempotent: no picture to remove is a no-op, not an error. */
    deleteProfilePicture(sessionId) {
        return this.getEngine(sessionId).deleteProfilePicture();
    }
    /** Map the JSON media body to a MediaInput exactly like the message module's media sends do. */
    setProfilePicture(sessionId, dto) {
        // base64 wins over url when both are present (mirrors buildMediaInput, #670).
        const media = (0, media_cap_util_1.resolveMediaBody)(dto, {
            fallbackMimetype: 'image/jpeg',
            requireMimetypeForBase64: true,
            checkUrl: true,
        });
        return this.getEngine(sessionId).setProfilePicture(media);
    }
};
exports.ProfileService = ProfileService;
exports.ProfileService = ProfileService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [engine_registry_service_1.EngineRegistry])
], ProfileService);
