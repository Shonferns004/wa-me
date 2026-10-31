"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const stream_1 = require("stream");
const constants_1 = require("@nestjs/common/constants");
const status_controller_1 = require("./status.controller");
/**
 * `getStatusMedia` serves third-party bytes from the API origin, exactly like the chat-media route
 * (message.controller.spec.ts holds that pair). StatusService already reduces the Content-Type to
 * an inert set, but defense is layered: attachment means even a mimetype mistake can never render
 * as active content here. The header was held by nothing — deleting the line passed every suite.
 */
describe('StatusController — stored status media download', () => {
    // A fresh stream per call: the service hands over an opened file, which can be read once.
    const getStatusMedia = jest.fn(() => Promise.resolve({ stream: stream_1.Readable.from([Buffer.from('GIF89a')]), size: 6, mimetype: 'image/gif' }));
    const controller = new status_controller_1.StatusController({ getStatusMedia });
    // Express merges the object form of `res.set` into the header bag; accumulating mirrors that
    // regardless of how many calls the handler splits its headers across.
    const mediaResponseHeaders = async () => {
        const headers = {};
        const res = { set: (fields) => Object.assign(headers, fields) };
        await controller.getStatusMedia('session-1', 'falsestatus@status', res);
        return headers;
    };
    it('sends nosniff, so a wrong Content-Type cannot be re-interpreted as active content', async () => {
        expect((await mediaResponseHeaders())['X-Content-Type-Options']).toBe('nosniff');
    });
    it('sends the media as an attachment, so it is never rendered on the API origin', async () => {
        expect((await mediaResponseHeaders())['Content-Disposition']).toBe('attachment');
    });
    // The headers are set on the response object directly; the bytes travel in the returned
    // StreamableFile, which Nest only sends for a passthrough-declared response parameter.
    it('declares the response passthrough, so Nest sends the returned file rather than discarding it', () => {
        expect(Reflect.getMetadata(constants_1.RESPONSE_PASSTHROUGH_METADATA, status_controller_1.StatusController, 'getStatusMedia')).toBe(true);
    });
    it('returns the stored bytes as the response body', async () => {
        const res = { set: () => undefined };
        const body = await controller.getStatusMedia('session-1', 'falsestatus@status', res);
        expect(body).toBeInstanceOf(common_1.StreamableFile);
        expect(body.getHeaders().length).toBe(6);
        expect(Buffer.concat(await body.getStream().toArray())).toEqual(Buffer.from('GIF89a'));
    });
});
