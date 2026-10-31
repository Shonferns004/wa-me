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
const whatsapp_web_js_adapter_1 = require("./whatsapp-web-js.adapter");
const wa_web_version_1 = require("../wa-web-version");
/**
 * The web version cache handed to the whatsapp-web.js Client. Unpinned, the library's default is a
 * local cache written to a cwd-relative directory after the link; in the container that directory
 * is not writable, the write throws before `ready`, and the session never becomes ready.
 */
describe('whatsapp-web.js web version cache', () => {
    let clientInitSpy;
    let savedWebVersion;
    let dataDir;
    const launchedCacheOption = async (webVersion) => {
        process.env.WWEBJS_WEB_VERSION = webVersion;
        const adapter = new whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter({
            sessionId: 'sess-web-version-cache',
            sessionDataPath: dataDir,
            puppeteer: {},
        });
        await adapter.initialize({});
        return adapter.client.options.webVersionCache;
    };
    beforeEach(() => {
        (0, wa_web_version_1.__resetWebVersionCache)();
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-web-version-'));
        savedWebVersion = process.env.WWEBJS_WEB_VERSION;
        // Build the real Client, whose options are merged over the library defaults, but launch no browser.
        clientInitSpy = jest
            .spyOn(whatsapp_web_js_1.Client.prototype, 'initialize')
            .mockResolvedValue(undefined);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        (0, wa_web_version_1.__resetWebVersionCache)();
        fs.rmSync(dataDir, { recursive: true, force: true });
        clientInitSpy.mockRestore();
        if (savedWebVersion === undefined) {
            delete process.env.WWEBJS_WEB_VERSION;
        }
        else {
            process.env.WWEBJS_WEB_VERSION = savedWebVersion;
        }
    });
    it('caches nothing to disk when no build is pinned', async () => {
        expect(await launchedCacheOption('off')).toEqual({ type: 'none' });
    });
    // whatsapp-web.js's remote cache fetches with no timeout and loads the live build on failure, so a
    // pinned build's HTML is downloaded first and served as a strict file on the data volume.
    it('serves a pinned build from a strict local cache under the session data path', async () => {
        const html = `<html>${'x'.repeat(2048)}</html>`;
        jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(html) });
        expect(await launchedCacheOption('2.3000.1000000000')).toEqual({
            type: 'local',
            path: path.join(path.resolve(dataDir), '.wa-web-cache'),
            strict: true,
        });
        expect(fs.readFileSync(path.join(dataDir, '.wa-web-cache', '2.3000.1000000000.html'), 'utf8')).toBe(html);
        // The library's own strict cache finds the file under the name it looks for.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const LocalWebCache = require('whatsapp-web.js/src/webCache/LocalWebCache');
        const cache = new LocalWebCache({ path: path.join(path.resolve(dataDir), '.wa-web-cache'), strict: true });
        await expect(cache.resolve('2.3000.1000000000')).resolves.toBe(html);
    });
    it('runs unpinned when the pinned build cannot be downloaded', async () => {
        jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
        expect(await launchedCacheOption('2.3000.1000000000')).toEqual({ type: 'none' });
    });
});
