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
require("reflect-metadata");
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const class_validator_2 = require("class-validator");
const class_validator_3 = require("class-validator");
const strict_boolean_1 = require("./strict-boolean");
// Mirrors the real pipe: whitelist + forbidNonWhitelisted from src/main.ts, and the
// enableImplicitConversion transform option from src/config/app-validation.ts. Leaving the
// transform option out here is what previously made a DTO spec pass while production accepted
// the opposite value.
const PIPE_VALIDATOR_OPTS = { whitelist: true, forbidNonWhitelisted: true };
const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };
class Subject {
    flag;
}
__decorate([
    (0, strict_boolean_1.ToStrictBoolean)(),
    (0, class_validator_2.ValidateIf)((o) => o.flag !== undefined),
    (0, class_validator_2.IsBoolean)(),
    __metadata("design:type", Boolean)
], Subject.prototype, "flag", void 0);
class Unguarded {
    flag;
}
__decorate([
    (0, class_validator_2.ValidateIf)((o) => o.flag !== undefined),
    (0, class_validator_2.IsBoolean)(),
    __metadata("design:type", Boolean)
], Unguarded.prototype, "flag", void 0);
async function run(cls, payload) {
    const instance = (0, class_transformer_1.plainToInstance)(cls, payload, PIPE_TRANSFORM_OPTS);
    const errors = await (0, class_validator_1.validate)(instance, PIPE_VALIDATOR_OPTS);
    return { instance, errors };
}
describe('ToStrictBoolean', () => {
    it('preserves real booleans', async () => {
        for (const value of [true, false]) {
            const { instance, errors } = await run(Subject, { flag: value });
            expect(instance.flag).toBe(value);
            expect(errors).toHaveLength(0);
        }
    });
    it('maps the canonical string spellings a form-encoded body produces', async () => {
        const asFalse = await run(Subject, { flag: 'false' });
        expect(asFalse.instance.flag).toBe(false);
        expect(asFalse.errors).toHaveLength(0);
        const asTrue = await run(Subject, { flag: 'true' });
        expect(asTrue.instance.flag).toBe(true);
        expect(asTrue.errors).toHaveLength(0);
    });
    it('rejects ambiguous spellings instead of guessing', async () => {
        for (const value of ['yes', 'no', '0', '1', 'FALSE', '']) {
            const { errors } = await run(Subject, { flag: value });
            expect(errors.length).toBeGreaterThan(0);
        }
    });
    it('leaves an absent property absent', async () => {
        const { instance, errors } = await run(Subject, {});
        expect(instance.flag).toBeUndefined();
        expect(errors).toHaveLength(0);
    });
    // Characterizes the behaviour the decorator exists to prevent. If this ever stops failing,
    // enableImplicitConversion was turned off and the decorator can be reconsidered.
    it('documents the unguarded behaviour it replaces: every non-empty string becomes true', async () => {
        for (const value of ['false', 'no', '0']) {
            const { instance, errors } = await run(Unguarded, { flag: value });
            expect(instance.flag).toBe(true);
            expect(errors).toHaveLength(0);
        }
    });
});
class NumberSubject {
    count;
}
__decorate([
    (0, strict_boolean_1.ToStrictNumber)(),
    (0, class_validator_2.ValidateIf)((o) => o.count !== undefined),
    (0, class_validator_3.IsInt)(),
    __metadata("design:type", Number)
], NumberSubject.prototype, "count", void 0);
class UnguardedNumber {
    count;
}
__decorate([
    (0, class_validator_2.ValidateIf)((o) => o.count !== undefined),
    (0, class_validator_3.IsInt)(),
    __metadata("design:type", Number)
], UnguardedNumber.prototype, "count", void 0);
describe('ToStrictNumber', () => {
    it('preserves real numbers and converts fully-numeric strings', async () => {
        for (const [input, expected] of [
            [7, 7],
            [0, 0],
            ['86400', 86400],
            ['0', 0],
        ]) {
            const { instance, errors } = await run(NumberSubject, { count: input });
            expect(instance.count).toBe(expected);
            expect(errors).toHaveLength(0);
        }
    });
    it('rejects blank and non-numeric strings instead of reading them as 0', async () => {
        for (const value of ['', '   ', 'abc', '1abc']) {
            const { errors } = await run(NumberSubject, { count: value });
            expect(errors.length).toBeGreaterThan(0);
        }
    });
    it('leaves an absent property absent', async () => {
        const { instance, errors } = await run(NumberSubject, {});
        expect(instance.count).toBeUndefined();
        expect(errors).toHaveLength(0);
    });
    // The behaviour the decorator exists to prevent: a blank form field arriving as a valid zero.
    it('documents the unguarded behaviour it replaces: a blank string becomes 0', async () => {
        const { instance, errors } = await run(UnguardedNumber, { count: '' });
        expect(instance.count).toBe(0);
        expect(errors).toHaveLength(0);
    });
});
class StringSubject {
    text;
}
__decorate([
    (0, strict_boolean_1.ToStrictString)(),
    (0, class_validator_2.ValidateIf)((o) => o.text !== undefined),
    (0, class_validator_3.IsString)(),
    __metadata("design:type", String)
], StringSubject.prototype, "text", void 0);
class UnguardedString {
    text;
}
__decorate([
    (0, class_validator_2.ValidateIf)((o) => o.text !== undefined),
    (0, class_validator_3.IsString)(),
    __metadata("design:type", String)
], UnguardedString.prototype, "text", void 0);
describe('ToStrictString', () => {
    it('keeps a string exactly as sent', async () => {
        for (const value of ['hello', '', '  padded  ', '628123456789', 'true']) {
            const { instance, errors } = await run(StringSubject, { text: value });
            expect(instance.text).toBe(value);
            expect(errors).toHaveLength(0);
        }
    });
    // A number keeps the conversion every release has had: no-code clients post a phone number held as a number.
    it.each([
        [628123456789, '628123456789'],
        [0, '0'],
        [-5, '-5'],
        [1.5, '1.5'],
        [1e21, '1e+21'],
    ])('reads the number %j as the string %j, as the pipe always did', async (value, expected) => {
        const { instance, errors } = await run(StringSubject, { text: value });
        expect(instance.text).toBe(expected);
        expect(errors).toHaveLength(0);
    });
    it('converts a number exactly as the unguarded pipe does', async () => {
        for (const value of [628123456789, 0, -0, -5, 1.5, 1e21, Number.MAX_SAFE_INTEGER]) {
            const guarded = await run(StringSubject, { text: value });
            const unguarded = await run(UnguardedString, { text: value });
            expect(guarded.instance.text).toBe(unguarded.instance.text);
        }
    });
    it.each([[true], [false], [{ order: 42 }], [['a']]])('rejects %j instead of reading it as text', async (value) => {
        const { instance, errors } = await run(StringSubject, { text: value });
        expect(instance.text).toEqual(value);
        expect(errors.map(e => e.property)).toEqual(['text']);
    });
    it('leaves an absent property absent and a null one null', async () => {
        const absent = await run(StringSubject, {});
        expect(absent.instance.text).toBeUndefined();
        expect(absent.errors).toHaveLength(0);
        const nulled = await run(StringSubject, { text: null });
        expect(nulled.instance.text).toBeNull();
    });
    // The behaviour the decorator exists to prevent: the customer receiving the literal "[object Object]".
    it('documents the unguarded behaviour it replaces: a boolean or object becomes a string', async () => {
        for (const [value, expected] of [
            [true, 'true'],
            [{ order: 42 }, '[object Object]'],
        ]) {
            const { instance, errors } = await run(UnguardedString, { text: value });
            expect(instance.text).toBe(expected);
            expect(errors).toHaveLength(0);
        }
    });
});
class Item {
    name;
}
__decorate([
    (0, class_validator_3.IsString)(),
    __metadata("design:type", String)
], Item.prototype, "name", void 0);
class ArraySubject {
    list;
    items;
}
__decorate([
    (0, strict_boolean_1.ToStrictArray)(),
    (0, class_validator_3.IsOptional)(),
    (0, class_validator_3.IsArray)(),
    (0, class_validator_3.IsString)({ each: true }),
    __metadata("design:type", Array)
], ArraySubject.prototype, "list", void 0);
__decorate([
    (0, strict_boolean_1.ToStrictArray)(),
    (0, class_validator_3.IsOptional)(),
    (0, class_validator_3.IsArray)(),
    (0, class_validator_3.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => Item),
    __metadata("design:type", Array)
], ArraySubject.prototype, "items", void 0);
class UnguardedArray {
    list;
    items;
}
__decorate([
    (0, class_validator_3.IsOptional)(),
    (0, class_validator_3.IsArray)(),
    (0, class_validator_3.IsString)({ each: true }),
    __metadata("design:type", Array)
], UnguardedArray.prototype, "list", void 0);
__decorate([
    (0, class_validator_3.IsOptional)(),
    (0, class_validator_3.IsArray)(),
    (0, class_validator_3.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => Item),
    __metadata("design:type", Array)
], UnguardedArray.prototype, "items", void 0);
describe('ToStrictArray', () => {
    // A JSON array behaves exactly as it does without the decorator: same converted value, same verdict.
    it.each([
        [{ list: [] }],
        [{ list: ['a'] }],
        [{ list: ['a', 'b'] }],
        [{ list: [1, 2] }],
        [{ list: [{ a: 1 }] }],
        [{ items: [] }],
        [{ items: [{ name: 'x' }] }],
        [{ items: [{ name: 5 }, { other: true }] }],
    ])('reads %j as the unguarded pipe does', async (payload) => {
        const guarded = await run(ArraySubject, payload);
        const unguarded = await run(UnguardedArray, payload);
        expect(guarded.instance).toEqual(unguarded.instance);
        expect(guarded.errors.map(e => e.property)).toEqual(unguarded.errors.map(e => e.property));
    });
    it('still builds the elements of a nested list', async () => {
        const { instance, errors } = await run(ArraySubject, { items: [{ name: 'x' }] });
        expect(errors).toHaveLength(0);
        expect(instance.items?.[0]).toBeInstanceOf(Item);
    });
    it.each([[{}], [{ a: 1 }], [{ '628111@c.us': true }], ['abc'], [5], [true]])('rejects %j instead of storing an empty list', async (value) => {
        const { instance, errors } = await run(ArraySubject, { list: value });
        expect(instance.list).toEqual(value);
        expect(Array.isArray(instance.list)).toBe(false);
        expect(errors.map(e => e.property)).toEqual(['list']);
    });
    it('leaves an absent property absent and a null one null', async () => {
        const absent = await run(ArraySubject, {});
        expect(absent.instance.list).toBeUndefined();
        expect(absent.errors).toHaveLength(0);
        const nulled = await run(ArraySubject, { list: null });
        expect(nulled.instance.list).toBeNull();
        expect(nulled.errors).toHaveLength(0);
    });
    // The behaviour the decorator exists to prevent: an object becoming an empty list, which an access
    // restriction read as "no restriction".
    it('documents the unguarded behaviour it replaces: an object becomes an empty list', async () => {
        for (const value of [{}, { a: 1 }, { '628111@c.us': true }]) {
            const { instance, errors } = await run(UnguardedArray, { list: value });
            expect(Array.isArray(instance.list)).toBe(true);
            expect(instance.list).toHaveLength(0);
            expect(errors).toHaveLength(0);
        }
    });
});
