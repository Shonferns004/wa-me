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
const path = __importStar(require("path"));
/**
 * The data connection dials PostgreSQL inside NestFactory.create, so a stopped built-in database has
 * to be started before that call or the boot crash-loops. The helper's own tests cannot see where
 * main.ts calls it: deleting the call, dropping its `await`, or moving it after NestFactory.create
 * would leave them green. This spec pins the order in main.ts.
 */
function prestartPrecedesCreate(mainSrc) {
    const prestart = mainSrc.search(/^\s*await\s+(?:\(0,\s*docker_service_1\.)?prestartBuiltinDatabase\)?\(\);/m);
    const create = mainSrc.search(/await\s+(?:core_1\.)?NestFactory\.create\(/);
    return prestart !== -1 && create !== -1 && prestart < create;
}
describe('built-in database prestart order in main.js', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
    it('awaits prestartBuiltinDatabase before NestFactory.create', () => {
        expect(prestartPrecedesCreate(mainSrc)).toBe(true);
    });
    it('the check fails when the call is missing, not awaited, or after create', () => {
        const create = 'const app = await NestFactory.create(AppModule);';
        expect(prestartPrecedesCreate(`  await prestartBuiltinDatabase();\n  ${create}`)).toBe(true);
        expect(prestartPrecedesCreate(`  ${create}`)).toBe(false);
        expect(prestartPrecedesCreate(`  void prestartBuiltinDatabase();\n  ${create}`)).toBe(false);
        expect(prestartPrecedesCreate(`  // await prestartBuiltinDatabase();\n  ${create}`)).toBe(false);
        expect(prestartPrecedesCreate(`  ${create}\n  await prestartBuiltinDatabase();`)).toBe(false);
    });
});
