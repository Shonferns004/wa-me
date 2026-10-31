"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const logger_service_1 = require("../../common/services/logger.service");
const tool_result_1 = require("./tool-result");
describe('smartToolResult', () => {
    it('inlines a small object as JSON text', () => {
        expect((0, tool_result_1.smartToolResult)({ id: 1 }).content).toEqual([{ type: 'text', text: '{"id":1}' }]);
    });
    it('passes a string payload through as plain text', () => {
        expect((0, tool_result_1.smartToolResult)('done').content).toEqual([{ type: 'text', text: 'done' }]);
    });
    it('survives an undefined handler result instead of throwing after the write ran', () => {
        // JSON.stringify(undefined) is undefined; reading .length off it threw a TypeError that
        // handleToolError then reported as `Internal error` for an operation that had succeeded.
        const result = (0, tool_result_1.smartToolResult)(undefined);
        expect(result.content).toEqual([{ type: 'text', text: 'null' }]);
    });
    // The threshold is 4 KB of UTF-8, not 4096 UTF-16 code units: multi-byte text must not inline at triple size.
    it.each(['x'.repeat(4096), '\u00e9'.repeat(2048), '\ud83d\ude00'.repeat(1024)])('inlines a payload of exactly 4096 UTF-8 bytes', text => {
        expect((0, tool_result_1.smartToolResult)(text).content).toEqual([{ type: 'text', text }]);
    });
    it.each(['x'.repeat(4097), '\u00e9'.repeat(2048) + 'x', '\u4e2d'.repeat(2000), '\ud83d\ude00'.repeat(1025)])('embeds a payload over 4096 UTF-8 bytes without changing its contents', text => {
        const { content } = (0, tool_result_1.smartToolResult)(text);
        expect(content).toHaveLength(2);
        const resource = content[1];
        if (resource.type !== 'resource' || !('blob' in resource.resource))
            throw new Error('expected a blob resource');
        expect(Buffer.from(resource.resource.blob, 'base64').toString('utf8')).toBe(text);
    });
    it('offloads a payload over 4 KB to an embedded resource', () => {
        const big = { blob: 'x'.repeat(5000) };
        const result = (0, tool_result_1.smartToolResult)(big);
        expect(result.content).toHaveLength(2);
        expect(result.content[0].type).toBe('text');
        expect(result.content[1]).toMatchObject({ type: 'resource', resource: { mimeType: 'application/json' } });
    });
});
describe('handleToolError logging', () => {
    let error;
    let warn;
    beforeEach(() => {
        error = jest.spyOn(logger_service_1.LoggerService.prototype, 'error').mockImplementation(() => undefined);
        warn = jest.spyOn(logger_service_1.LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());
    it('logs a client-caused 4xx at warn without a stack, as REST leaves it unlogged', () => {
        (0, tool_result_1.handleToolError)(new common_1.NotFoundException('Session x not found'));
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('MCP tool error 404: Session x not found');
    });
    it('keeps a 5xx at error with its stack', () => {
        const failure = new common_1.ServiceUnavailableException('engine down');
        (0, tool_result_1.handleToolError)(failure);
        expect(error).toHaveBeenCalledWith('engine down', failure.stack);
        expect(warn).not.toHaveBeenCalled();
    });
});
