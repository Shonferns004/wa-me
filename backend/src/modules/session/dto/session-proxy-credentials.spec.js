"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const app_validation_1 = require("../../../config/app-validation");
const session_proxy_dto_1 = require("./session-proxy.dto");
const create_session_dto_1 = require("./create-session.dto");
/**
 * A proxy URL whose credentials carry a percent that begins no escape passes `@IsUrl` and `new URL()`,
 * and only throws later, inside whichever library decodes it. Both routes that accept one must refuse
 * it at the boundary, so this drives the real global pipe rather than the validator alone.
 */
describe('proxy credential escapes on both routes that accept a proxy URL', () => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const through = (metatype, value) => pipe.transform(value, { type: 'body', metatype: metatype });
    const BAD = 'http://u:pa%ss@proxy.local:8080';
    /** The per-field messages the pipe collects, which is where a constraint's own wording lands. */
    const messagesFrom = async (metatype, value) => {
        try {
            await through(metatype, value);
        }
        catch (error) {
            expect(error).toBeInstanceOf(common_1.BadRequestException);
            const body = error.getResponse();
            return body.message ?? [];
        }
        throw new Error('expected the pipe to reject');
    };
    it('refuses it on the proxy update route, naming the escape', async () => {
        expect(await messagesFrom(session_proxy_dto_1.UpdateSessionProxyDto, { proxyUrl: BAD })).toEqual([
            expect.stringContaining('invalid percent-escape'),
        ]);
    });
    it('refuses it on the session create route', async () => {
        expect(await messagesFrom(create_session_dto_1.CreateSessionDto, { name: 'sess', proxyUrl: BAD })).toEqual([
            expect.stringContaining('invalid percent-escape'),
        ]);
    });
    it('accepts an escaped percent, an encoded credential and no credentials at all', async () => {
        await expect(through(session_proxy_dto_1.UpdateSessionProxyDto, { proxyUrl: 'http://u:pa%25ss@proxy.local:8080' })).resolves.toBeDefined();
        await expect(through(session_proxy_dto_1.UpdateSessionProxyDto, { proxyUrl: 'socks5://user:p%40ss@proxy.local:1080' })).resolves.toBeDefined();
        await expect(through(session_proxy_dto_1.UpdateSessionProxyDto, { proxyUrl: 'http://proxy.local:8080' })).resolves.toBeDefined();
    });
    it('leaves clearing the proxy with null alone', async () => {
        await expect(through(session_proxy_dto_1.UpdateSessionProxyDto, { proxyUrl: null })).resolves.toBeDefined();
    });
});
