"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HasDecodableProxyCredentialsConstraint = void 0;
exports.hasDecodableProxyCredentials = hasDecodableProxyCredentials;
const class_validator_1 = require("class-validator");
/**
 * Whether a proxy URL's credentials can be percent-decoded.
 *
 * `@IsUrl` accepts `http://user:pa%ss@proxy:8080`, and so does `new URL()`, which keeps the
 * credentials percent-encoded. Every consumer decodes them, and a lone `%` that begins no valid
 * escape makes `decodeURIComponent` throw `URI malformed`: inside the Baileys WebSocket agent, inside
 * undici's ProxyAgent, inside the whatsapp-web.js Chromium launch, and on the SSRF-guarded fetch of a
 * caller-supplied URL. Three of those four are library code, so the throw surfaces as an opaque
 * failure with nothing naming the credentials, and the session stays unstartable until an operator
 * guesses.
 *
 * Checked at the boundary instead, where the message can say what to do. A literal `%` in a password
 * is written `%25`.
 */
function hasDecodableProxyCredentials(value) {
    if (typeof value !== 'string' || value === '')
        return true; // other validators own shape and emptiness
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return true; // not a URL at all: @IsUrl reports that, and a second message would only confuse
    }
    try {
        decodeURIComponent(url.username);
        decodeURIComponent(url.password);
        return true;
    }
    catch {
        return false;
    }
}
let HasDecodableProxyCredentialsConstraint = class HasDecodableProxyCredentialsConstraint {
    validate(value) {
        return hasDecodableProxyCredentials(value);
    }
    defaultMessage() {
        return 'proxyUrl credentials contain an invalid percent-escape; write a literal % as %25';
    }
};
exports.HasDecodableProxyCredentialsConstraint = HasDecodableProxyCredentialsConstraint;
exports.HasDecodableProxyCredentialsConstraint = HasDecodableProxyCredentialsConstraint = __decorate([
    (0, class_validator_1.ValidatorConstraint)({ name: 'hasDecodableProxyCredentials', async: false })
], HasDecodableProxyCredentialsConstraint);
