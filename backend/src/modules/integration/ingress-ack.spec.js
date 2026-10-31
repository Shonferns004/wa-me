"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ingress_ack_1 = require("./ingress-ack");
const ctx = { rawBody: '{"a":1}', timestamp: '1700000000', id: 'd1' };
describe('renderAck', () => {
    it('returns the default 202 ack when no spec is declared', () => {
        expect((0, ingress_ack_1.renderAck)(undefined, ctx)).toEqual({ status: 202, body: 'accepted' });
    });
    it('renders a declared status and body verbatim', () => {
        expect((0, ingress_ack_1.renderAck)({ status: 200, body: '{"ok":true}' }, ctx)).toEqual({ status: 200, body: '{"ok":true}' });
    });
    it('substitutes {rawBody}/{timestamp}/{id} templates', () => {
        expect((0, ingress_ack_1.renderAck)({ body: 'echo:{rawBody}:{id}:{timestamp}' }, ctx).body).toBe('echo:{"a":1}:d1:1700000000');
    });
    it('passes through declared headers', () => {
        expect((0, ingress_ack_1.renderAck)({ headers: { 'content-type': 'application/json' } }, ctx).headers).toEqual({
            'content-type': 'application/json',
        });
    });
    it('substitutes literally even when rawBody contains $ characters (no regex/$ semantics)', () => {
        expect((0, ingress_ack_1.renderAck)({ body: '{rawBody}' }, { ...ctx, rawBody: '$&$`$1' }).body).toBe('$&$`$1');
    });
    it('substitutes only the original template tokens and preserves inserted values literally', () => {
        const literal = {
            rawBody: '{timestamp}:{id}:$&:$1:{rawBody}',
            timestamp: '{id}:$&:$1',
            id: '{rawBody}:{timestamp}:$&:$1',
        };
        expect((0, ingress_ack_1.renderAck)({ body: '{rawBody}|{timestamp}|{id}|{rawBody}|{unknown}' }, literal).body).toBe('{timestamp}:{id}:$&:$1:{rawBody}|{id}:$&:$1|{rawBody}:{timestamp}:$&:$1|{timestamp}:{id}:$&:$1:{rawBody}|{unknown}');
        expect((0, ingress_ack_1.renderAck)({ body: '{rawBody}{timestamp}{id}' }, { rawBody: '', timestamp: '', id: '' }).body).toBe('');
    });
    it('omits body and headers when not declared', () => {
        expect((0, ingress_ack_1.renderAck)({ status: 204 }, ctx)).toEqual({ status: 204 });
    });
});
describe('ackContentType', () => {
    it('falls back to text/plain when no headers or no content-type are declared', () => {
        expect((0, ingress_ack_1.ackContentType)(undefined)).toBe('text/plain');
        expect((0, ingress_ack_1.ackContentType)({})).toBe('text/plain');
        expect((0, ingress_ack_1.ackContentType)({ 'x-ack': '1' })).toBe('text/plain');
    });
    it('honors an allowlisted type, returning the bare media type', () => {
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'application/json' })).toBe('application/json');
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'application/json; charset=utf-8' })).toBe('application/json');
    });
    it('drops a parameter list Express could not parse', () => {
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'application/json;' })).toBe('application/json');
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'application/json; charset=utf-8;' })).toBe('application/json');
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'application/json; foo' })).toBe('application/json');
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'text/plain;' })).toBe('text/plain');
    });
    it('matches the header name and the media type case-insensitively', () => {
        expect((0, ingress_ack_1.ackContentType)({ 'Content-Type': 'Application/JSON' })).toBe('application/json');
    });
    it('forces text/plain for anything a browser could execute', () => {
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'text/html' })).toBe('text/plain');
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'image/svg+xml' })).toBe('text/plain');
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'application/xhtml+xml' })).toBe('text/plain');
        // A prefix that merely starts with an allowlisted type must not slip through.
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 'application/json-but-html' })).toBe('text/plain');
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': '' })).toBe('text/plain');
    });
});
describe('safeAckHeaders (a plugin-authored ack cannot undo the app response contract)', () => {
    it('drops every reserved name, whatever the case, and keeps everything else', () => {
        const reserved = {
            'Content-Type': 'text/html',
            'Content-Length': '99',
            'Transfer-Encoding': 'chunked',
            'Content-Encoding': 'gzip',
            Trailer: 'X-Checksum',
            'Content-Security-Policy': 'default-src *',
            'X-Content-Type-Options': 'nosniff-not',
            'X-Frame-Options': 'ALLOWALL',
            'Strict-Transport-Security': 'max-age=0',
            'Referrer-Policy': 'unsafe-url',
            'Set-Cookie': 'a=b',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        };
        // Every name is asserted, so removing any one of them from the set fails this.
        expect((0, ingress_ack_1.safeAckHeaders)(reserved)).toEqual({});
        expect((0, ingress_ack_1.safeAckHeaders)({ ...reserved, 'X-Provider-Ack': 'ok' })).toEqual({ 'X-Provider-Ack': 'ok' });
    });
    it('drops the framing headers, which decide how the response is delimited and decoded', () => {
        // The host frames the ack and never compresses it. A declared content encoding describes bytes
        // the ack does not carry, so the provider's client fails to decode it and retries a delivery
        // already queued; a declared Trailer makes Node refuse to write the response at all, which on a
        // length-framed body throws past the request and takes the process with it.
        expect((0, ingress_ack_1.safeAckHeaders)({ 'transfer-encoding': 'chunked' })).toEqual({});
        expect((0, ingress_ack_1.safeAckHeaders)({ 'content-encoding': 'gzip' })).toEqual({});
        expect((0, ingress_ack_1.safeAckHeaders)({ trailer: 'X-Checksum' })).toEqual({});
    });
    it('is total: no headers, and a non-string value, both answer an object', () => {
        expect((0, ingress_ack_1.safeAckHeaders)(undefined)).toEqual({});
        expect((0, ingress_ack_1.safeAckHeaders)({ 'X-N': 7 })).toEqual({});
    });
});
describe('renderAck / ackContentType stay total on a manifest the loader did not type-check', () => {
    const ctx = { rawBody: '{}', timestamp: '1', id: 'd1' };
    it('ignores a non-string body and a non-number status instead of throwing', () => {
        const spec = { status: '204', body: 7 };
        expect((0, ingress_ack_1.renderAck)(spec, ctx)).toEqual({ status: 202 });
    });
    it('ignores a non-string declared content type', () => {
        expect((0, ingress_ack_1.ackContentType)({ 'content-type': 7 })).toBe('text/plain');
    });
});
