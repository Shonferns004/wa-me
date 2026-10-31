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
exports.LabelService = void 0;
const common_1 = require("@nestjs/common");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
/**
 * Owns engine access for label operations so the "session not started" guard and label
 * business rules (not-found mapping) live behind the service boundary, not in the controller.
 */
let LabelService = class LabelService {
    engines;
    constructor(engines) {
        this.engines = engines;
    }
    getEngine(sessionId) {
        // EngineRegistry.require()'s default is this exact 400 "Session is not started".
        return this.engines.require(sessionId);
    }
    getLabels(sessionId) {
        return this.getEngine(sessionId).getLabels();
    }
    async getLabelById(sessionId, labelId) {
        const label = await this.getEngine(sessionId).getLabelById(labelId);
        if (!label) {
            throw new common_1.NotFoundException(`Label ${labelId} not found`);
        }
        return label;
    }
    getChatLabels(sessionId, chatId) {
        return this.getEngine(sessionId).getChatLabels(chatId);
    }
    /**
     * Create or update a label. One operation on purpose: WhatsApp carries a single `label_edit`
     * write keyed by the label id, so whether this creates or updates depends only on whether that id
     * already exists — which is also why the caller chooses the id rather than being handed one.
     */
    upsertLabel(sessionId, labelId, body) {
        // Both fields are individually optional, but the write replaces the whole label, so an omitted
        // field is not kept (a colour-only write clears the name). A body that sets neither has nothing to
        // write, so it is refused like the group-settings PUT refuses an empty patch. `null` counts as
        // "not set": class-validator's @IsOptional skips validation for it and class-transformer keeps
        // it, so {"name": null} reached here as an explicit nothing.
        const name = body.name ?? undefined;
        const color = body.color ?? undefined;
        if (name === undefined && color === undefined) {
            throw new common_1.BadRequestException('At least one of name or color must be provided');
        }
        return this.getEngine(sessionId).upsertLabel({
            id: labelId,
            ...(name === undefined ? {} : { name }),
            ...(color === undefined ? {} : { color }),
        });
    }
    deleteLabel(sessionId, labelId) {
        return this.getEngine(sessionId).deleteLabel(labelId);
    }
    getChatsByLabel(sessionId, labelId) {
        return this.getEngine(sessionId).getChatsByLabel(labelId);
    }
    addLabelToChat(sessionId, chatId, labelId) {
        return this.getEngine(sessionId).addLabelToChat(chatId, labelId);
    }
    removeLabelFromChat(sessionId, chatId, labelId) {
        return this.getEngine(sessionId).removeLabelFromChat(chatId, labelId);
    }
};
exports.LabelService = LabelService;
exports.LabelService = LabelService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [engine_registry_service_1.EngineRegistry])
], LabelService);
