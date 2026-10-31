"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportDataDto = void 0;
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const strict_boolean_1 = require("../../../common/utils/strict-boolean");
const table_importers_1 = require("../table-importers");
/**
 * The table keys the restore actually reads, derived from the importer registry rather than restated,
 * so a table added to TABLE_IMPORTERS cannot go missing from the published body schema.
 */
const TABLE_PROPERTIES = Object.fromEntries(table_importers_1.TABLE_IMPORTERS.map((importer) => [importer.key, { type: 'array' }]));
/**
 * Body for POST /infra/import-data, the replace-all restore. A class (not an inline object literal)
 * so the global ValidationPipe's whitelist/forbidNonWhitelisted actually runs — the same reason
 * ImportStorageDto is one. An inline `@Body()` type erases at runtime, so on the most destructive
 * route in the product a body carrying no `tables` reached the handler and failed as a 500 from
 * inside the restore, and a misspelled key was accepted in silence.
 *
 * `tables` is validated as an object and not descended into: without @ValidateNested the per-table
 * row arrays are leaf values, so whitelist cannot strip them. That is load-bearing, not incidental —
 * every key omitted here is restored EMPTY, so a whitelist that reached inside would silently blank
 * the database it was asked to restore.
 *
 * Both flags only ever OPEN an escape from the orphan-engine refusal, so they are kept strict. Under
 * the pipe's enableImplicitConversion a plain `boolean` property casts every non-empty string —
 * `'false'` among them — to `true` before @IsBoolean() can object, which would open that escape for
 * a caller who spelled the opposite. @ToStrictBoolean accepts only a real boolean or an exact
 * 'true'/'false' and leaves anything else to be refused. An absent flag stays absent, so the default
 * path is still the visible 409 IMPORT_WOULD_ORPHAN_ENGINES.
 *
 * The body IS the export file: `docs/14` tells the operator to post it whole, and the export wraps
 * `tables` in five metadata fields. They are declared with @Allow — accepted, never read — because
 * `forbidNonWhitelisted` rejects any property the class does not name, and rejecting the product's
 * own backup would break the restore this route exists for. They carry no constraints on purpose: a
 * restore must not fail over the shape of a field it ignores, including one written by an older
 * release. `import-data.dto.spec.ts` binds this list to the export contract, so a field added to the
 * export cannot silently start failing the import again.
 */
class ImportDataDto {
    tables;
    force;
    stopOrphans;
    // ---- Export-envelope metadata: accepted so the backup posts back verbatim, never read. ----
    // Each carries an explicit published `type` matching what the export sends. The declared TS type is
    // `unknown` because the restore never reads them, but an untyped @ApiPropertyOptional over `unknown`
    // publishes `type: object`, which for `exportedAt` breaks the contract invariant that a timestamp
    // property is never a bare object (`openapi-contract.spec.ts`).
    exportedAt;
    dataDbType;
    counts;
    skippedTables;
    omittedInlineMedia;
}
exports.ImportDataDto = ImportDataDto;
__decorate([
    (0, swagger_1.ApiProperty)({
        type: 'object',
        description: `Every one of the ${table_importers_1.TABLE_IMPORTERS.length} migration tables is emptied before the restore runs, so a key omitted here is restored EMPTY rather than left untouched. Post the whole GET /api/infra/export-data payload, not a hand-built subset.`,
        properties: TABLE_PROPERTIES,
    }),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], ImportDataDto.prototype, "tables", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        description: 'Allow the replace to proceed even while engines are running for sessions the backup does not contain (they keep running until restart; see restartRequired). Prefer stopOrphans, which closes that window inside this request instead.',
    }),
    (0, strict_boolean_1.ToStrictBoolean)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], ImportDataDto.prototype, "force", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        description: 'Stop the running engines for sessions the backup does not contain, inside this request and before the replace runs. Supersedes force for the orphan case: with stopOrphans the engines no longer need a process restart to reconcile, so restartRequired stays false on the success path.',
    }),
    (0, strict_boolean_1.ToStrictBoolean)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], ImportDataDto.prototype, "stopOrphans", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ type: 'string', description: 'Ignored. Present so the export file posts back unmodified.' }),
    (0, class_validator_1.Allow)(),
    __metadata("design:type", Object)
], ImportDataDto.prototype, "exportedAt", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ type: 'string', description: 'Ignored. Present so the export file posts back unmodified.' }),
    (0, class_validator_1.Allow)(),
    __metadata("design:type", Object)
], ImportDataDto.prototype, "dataDbType", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        type: 'object',
        additionalProperties: { type: 'number' },
        description: 'Ignored. Present so the export file posts back unmodified.',
    }),
    (0, class_validator_1.Allow)(),
    __metadata("design:type", Object)
], ImportDataDto.prototype, "counts", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        type: 'array',
        items: { type: 'string' },
        description: 'Ignored. Present so the export file posts back unmodified.',
    }),
    (0, class_validator_1.Allow)(),
    __metadata("design:type", Object)
], ImportDataDto.prototype, "skippedTables", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        type: 'object',
        additionalProperties: { type: 'number' },
        description: 'Ignored. Present so the export file posts back unmodified.',
    }),
    (0, class_validator_1.Allow)(),
    __metadata("design:type", Object)
], ImportDataDto.prototype, "omittedInlineMedia", void 0);
