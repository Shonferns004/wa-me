"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WwebjsProfile = void 0;
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const wwebjs_messaging_1 = require("./wwebjs-messaging");
const wwebjs_host_1 = require("./wwebjs-host");
/**
 * Own-account profile operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public
 * methods as thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so
 * the delegate never touches lifecycle state directly.
 */
class WwebjsProfile {
    host;
    constructor(host) {
        this.host = host;
    }
    /** Post-ensureReady client handle. */
    client() {
        return this.host.getClient();
    }
    /** See {@link withPage} for what a dead page answers here. */
    withPage(context, op) {
        return (0, wwebjs_host_1.withPage)(this.host, context, op);
    }
    async createCallLink(type, startTime) {
        this.host.ensureReady();
        // whatsapp-web.js rejects any callType outside 'voice' | 'video', so the neutral 'audio' maps
        // here. It floors the Date to seconds itself, so the epoch-milliseconds the contract takes goes
        // straight into the Date.
        // Non-idempotent: each call mints a NEW server-side link, so a client replaying a 503 would
        // create a second one. Report a dead page and keep the 500. Same rule as createChannel; see
        // reportPageDeath.
        const link = await (0, wwebjs_host_1.reportPageDeath)(this.host, 'createCallLink', () => this.client().createCallLink(new Date(startTime), type === 'video' ? 'video' : 'voice'));
        if (!link) {
            // Documented as "the link, or an empty string if a generation failed" — returning that empty
            // string would hand the caller a success with nothing in it.
            throw new engine_refused_error_1.EngineRefusedError('WhatsApp did not return a call link');
        }
        return link;
    }
    async deleteProfilePicture() {
        this.host.ensureReady();
        // `Promise<boolean>` understates this. `WWebJS.deletePicture` has three exits
        // (Injected/Utils.js:1404-1418): `undefined` when `canDelete()` was false and nothing was
        // attempted, `true` on an HTTP 200, `false` on a ServerStatusCodeError. `undefined` is falsy, so
        // the usual `if (!ok) throw` would report "there was nothing to delete" as a refusal and turn a
        // repeat delete into a 403. Only an explicit `false` is WhatsApp saying no.
        const result = await this.withPage('deleteProfilePicture', () => this.client().deleteProfilePicture());
        if (result === false) {
            throw new engine_refused_error_1.EngineRefusedError('the engine rejected the profile picture removal');
        }
        this.host.logger.log('Deleted profile picture');
    }
    async setProfileName(name) {
        this.host.ensureReady();
        // setDisplayName resolves false (rather than throwing) when WhatsApp refuses the rename.
        const ok = await this.withPage('setProfileName', () => this.client().setDisplayName(name));
        if (!ok) {
            throw new engine_refused_error_1.EngineRefusedError('the engine rejected the profile name change');
        }
        this.host.logger.log('Updated profile name');
    }
    async setProfileStatus(status) {
        this.host.ensureReady();
        await this.withPage('setProfileStatus', () => this.client().setStatus(status));
        this.host.logger.log('Updated profile status');
    }
    async setProfilePicture(media) {
        this.host.ensureReady();
        const messageMedia = await (0, wwebjs_messaging_1.toMessageMedia)(media, this.host.config.proxy?.url);
        // setProfilePicture resolves false (rather than throwing) when the upload is refused.
        const ok = await this.withPage('setProfilePicture', () => this.client().setProfilePicture(messageMedia));
        if (!ok) {
            throw new engine_refused_error_1.EngineRefusedError('the engine rejected the profile picture change');
        }
        this.host.logger.log('Updated profile picture');
    }
}
exports.WwebjsProfile = WwebjsProfile;
