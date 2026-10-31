"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.containsNul = exports.NoNulCharacter = void 0;
const class_validator_1 = require("class-validator");
/** PostgreSQL text and varchar columns cannot store U+0000, so the write would fail as a 500. */
const NoNulCharacter = () => (0, class_validator_1.NotContains)('\u0000', { message: '$property must not contain a NUL character' });
exports.NoNulCharacter = NoNulCharacter;
/** Whether a string anywhere in a parsed request value holds U+0000, which PostgreSQL rejects as a parameter. */
const containsNul = (value) => typeof value === 'string'
    ? value.includes('\u0000')
    : typeof value === 'object' && value !== null && Object.values(value).some(exports.containsNul);
exports.containsNul = containsNul;
