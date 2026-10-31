"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelMediaNotSupportedError = void 0;
const common_1 = require("@nestjs/common");
/**
 * Thrown by the whatsapp-web.js engine adapter when a media send (image/video/audio/document/sticker)
 * targets a channel (`<id>@newsletter`). whatsapp-web.js constructs the channel message and calls `msg.avParams()`
 * (Utils.js), a WhatsApp-Web-page method removed in a recent WA Web build, so the send crashes with
 * `TypeError: msg.avParams is not a function` (upstream wwebjs#201823, unresolved). Text→channel still
 * works; only media is affected.
 *
 * Extends NestJS `NotImplementedException` so it maps to **HTTP 501** through the built-in exception
 * handler — no custom global filter required. Mirrors how {@link ChatLabelsUnsupportedError} maps to 422
 * and {@link ChannelNotFoundError} to 404.
 */
class ChannelMediaNotSupportedError extends common_1.NotImplementedException {
    constructor(message = 'Sending media to channels (@newsletter) is not supported by the whatsapp-web.js engine.') {
        super(message);
    }
}
exports.ChannelMediaNotSupportedError = ChannelMediaNotSupportedError;
