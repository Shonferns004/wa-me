"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const whatsapp_web_js_1 = require("whatsapp-web.js");
const configuration_1 = require("../../../config/configuration");
const index_1 = require("./index");
/**
 * The Chromium flags a session launches with when no args are configured. The plugin passes
 * whatever it was given and the adapter owns the one fallback, so both paths are driven here
 * through the real plugin, adapter and wwebjs Client (with the browser launch stubbed out).
 */
describe('whatsapp-web.js launch args', () => {
    const SESSION_ID = 'sess-launch-args';
    let tmpRoot;
    let clientInitSpy;
    let savedWebVersion;
    const launchedArgs = async (config) => {
        const plugin = new index_1.WhatsAppWebJsPlugin({ sessionDataPath: tmpRoot, ...config });
        const adapter = plugin.createEngine({ sessionId: SESSION_ID });
        await adapter.initialize({});
        return adapter.client.options.puppeteer
            .args;
    };
    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-launch-args-'));
        savedWebVersion = process.env.WWEBJS_WEB_VERSION;
        process.env.WWEBJS_WEB_VERSION = 'off';
        clientInitSpy = jest
            .spyOn(whatsapp_web_js_1.Client.prototype, 'initialize')
            .mockResolvedValue(undefined);
    });
    afterEach(() => {
        clientInitSpy.mockRestore();
        if (savedWebVersion === undefined)
            delete process.env.WWEBJS_WEB_VERSION;
        else
            process.env.WWEBJS_WEB_VERSION = savedWebVersion;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
    it.each([
        ['no puppeteer config', {}],
        ['a persisted puppeteer override without args', { puppeteer: { headless: true } }],
    ])('launches with the documented default flags and locale pin for %s', async (_label, config) => {
        expect(await launchedArgs(config)).toEqual([
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            `--lang=${configuration_1.PINNED_BROWSER_LOCALE}`,
            `--openwa-session=${SESSION_ID}`,
        ]);
        expect(configuration_1.DEFAULT_PUPPETEER_ARGS).toEqual([
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ]);
    });
    it('uses configured args verbatim and never mutates the shared array', async () => {
        const args = ['--no-sandbox', '--lang=de-DE'];
        expect(await launchedArgs({ puppeteer: { args } })).toEqual([
            '--no-sandbox',
            '--lang=de-DE',
            `--openwa-session=${SESSION_ID}`,
        ]);
        expect(args).toEqual(['--no-sandbox', '--lang=de-DE']);
    });
});
