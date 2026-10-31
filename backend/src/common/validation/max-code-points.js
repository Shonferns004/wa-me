"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaxCodePoints = MaxCodePoints;
const class_validator_1 = require("class-validator");
/**
 * Bound a string by code points, the unit PostgreSQL counts a `varchar(n)` in. `@MaxLength` does not:
 * it folds a presentation selector (U+FE0F) into the character before it, so a value it passes can
 * still overflow the column and fail the INSERT with a 500. The `u` flag makes each matched unit one
 * code point.
 */
function MaxCodePoints(max, options) {
    return (0, class_validator_1.Matches)(new RegExp(`^[\\s\\S]{0,${max}}$`, 'u'), {
        message: `$property must be shorter than or equal to ${max} characters`,
        ...options,
    });
}
