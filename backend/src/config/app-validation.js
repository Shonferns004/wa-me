"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NulBodyPipe = exports.GLOBAL_VALIDATION_OPTIONS = void 0;
exports.applyGlobalValidation = applyGlobalValidation;
const common_1 = require("@nestjs/common");
const bootstrap_security_1 = require("./bootstrap-security");
const no_nul_character_1 = require("../common/validation/no-nul-character");
const import_data_dto_1 = require("../modules/infra/dto/import-data.dto");
/**
 * The DTO validation contract itself, without the one option that depends on the environment.
 *
 * Exported so a spec can construct the real pipe from the same object production uses instead of
 * restating the options as literals. A restated copy is a mirror, and a mirror can drift: loosening
 * `whitelist` here would leave every spec that hardcoded `whitelist: true` still asserting the old
 * contract, green, while the running app no longer honours it. Reading one object makes production
 * and the specs unable to disagree — and turns those specs into a gate over this file.
 *
 * `disableErrorMessages` is deliberately NOT here: it is resolved from the environment at call time,
 * so it is not part of the contract a spec should reproduce.
 */
exports.GLOBAL_VALIDATION_OPTIONS = {
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
};
/**
 * Refuses a request body holding U+0000 anywhere. PostgreSQL rejects it in every text and varchar value
 * and bound parameter, so it failed the lookup or write behind the route as a 500 while SQLite took it.
 * The restore is exempt: a SQLite backup may hold one in a message, and the importers drop it from the
 * same free-text columns the entities clean.
 */
class NulBodyPipe {
    transform(value, { type, metatype }) {
        if (type === 'body' && metatype !== import_data_dto_1.ImportDataDto && (0, no_nul_character_1.containsNul)(value)) {
            throw new common_1.BadRequestException('Request body must not contain a NUL character');
        }
        return value;
    }
}
exports.NulBodyPipe = NulBodyPipe;
/** Apply the HTTP prefix and DTO validation contract shared by production and e2e applications. */
function applyGlobalValidation(app) {
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new common_1.ValidationPipe({
        ...exports.GLOBAL_VALIDATION_OPTIONS,
        disableErrorMessages: !(0, bootstrap_security_1.isValidationErrorDetailEnabled)(process.env.VALIDATION_ERROR_DETAIL, process.env.NODE_ENV),
    }), new NulBodyPipe());
}
