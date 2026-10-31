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
const dotenv = __importStar(require("dotenv"));
const bootstrap_security_1 = require("./bootstrap-security");
/**
 * `.env.example` is both the "copy me" template and a self-described production config — it ships
 * `NODE_ENV=production` uncommented. Anything else shipped uncommented becomes a PIN the moment an
 * operator copies the file, so a setting that defaults OFF under production must not be pre-selected
 * ON in the template: copying it would silently opt a production host into the very thing the
 * default exists to withhold.
 *
 * This is deliberately BEHAVIOURAL rather than lexical. A lexical "KEY must not appear uncommented"
 * rule mis-fires on settings shipped uncommented in the SAFE direction, and it cannot tell the two
 * apart. Here the template is parsed and the REAL resolvers are run over it, so a key only counts
 * when the template's own value resolves ON while the unset default would resolve OFF.
 */
/** Resolvers that default OFF under production and are forced ON by an explicit `true`. */
const PRODUCTION_OFF_OPT_INS = [
    { key: 'ENABLE_SWAGGER', resolve: bootstrap_security_1.isSwaggerEnabled },
    { key: 'VALIDATION_ERROR_DETAIL', resolve: bootstrap_security_1.isValidationErrorDetailEnabled },
];
/**
 * The production-off opt-ins a copied template would pre-select. Empty for a template that does not
 * declare production — the rule is about what `cp .env.example .env` pins on a production host.
 */
function preSelectedOptIns(templateText) {
    const env = dotenv.parse(templateText);
    if (env.NODE_ENV !== 'production')
        return [];
    return PRODUCTION_OFF_OPT_INS.filter(optIn => optIn.resolve(env[optIn.key], env.NODE_ENV) && !optIn.resolve(undefined, env.NODE_ENV)).map(optIn => optIn.key);
}
describe('.env.example does not pre-select a production-off opt-in', () => {
    const templatePath = path.join(__dirname, '..', '..', '.env.example');
    const template = fs.readFileSync(templatePath, 'utf8');
    it('pre-selects nothing that production defaults off', () => {
        expect(preSelectedOptIns(template)).toEqual([]);
    });
    it('still gives a developer the documented defaults when they set NODE_ENV=development', () => {
        // The reason a bare removal is not the fix: shipping `ENABLE_SWAGGER=false` would also satisfy
        // the assertion above while breaking the contributor workflow that copies this same file.
        const env = dotenv.parse(template);
        expect((0, bootstrap_security_1.isSwaggerEnabled)(env.ENABLE_SWAGGER, 'development')).toBe(true);
        expect((0, bootstrap_security_1.isValidationErrorDetailEnabled)(env.VALIDATION_ERROR_DETAIL, 'development')).toBe(true);
    });
    it('leaves the documented production opt-in working when an operator sets it themselves', () => {
        expect((0, bootstrap_security_1.isSwaggerEnabled)('true', 'production')).toBe(true);
        expect((0, bootstrap_security_1.isValidationErrorDetailEnabled)('true', 'production')).toBe(true);
    });
    // Self-mutation controls: the check must be capable of firing, and must not fire on the safe cases.
    it('fires when a production-off opt-in is shipped uncommented', () => {
        expect(preSelectedOptIns(`${template}\nVALIDATION_ERROR_DETAIL=true\n`)).toEqual(['VALIDATION_ERROR_DETAIL']);
        expect(preSelectedOptIns(`${template}\nENABLE_SWAGGER=true\n`)).toEqual(['ENABLE_SWAGGER']);
    });
    it('does not fire on a template that declares a non-production environment', () => {
        const asDevelopment = `${template}\nNODE_ENV=development\nENABLE_SWAGGER=true\n`;
        expect(preSelectedOptIns(asDevelopment)).toEqual([]);
    });
    it('does not fire on a setting shipped uncommented in the safe direction', () => {
        expect(preSelectedOptIns(`${template}\nVALIDATION_ERROR_DETAIL=false\n`)).toEqual([]);
    });
});
