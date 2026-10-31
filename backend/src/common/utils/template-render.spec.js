"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const template_render_1 = require("./template-render");
describe('renderTemplate', () => {
    describe('canonical double-brace {{name}}', () => {
        it('substitutes a known placeholder', () => {
            expect((0, template_render_1.renderTemplate)('Hi {{name}}', { name: 'Sam' })).toBe('Hi Sam');
        });
        it('tolerates surrounding whitespace', () => {
            expect((0, template_render_1.renderTemplate)('Hi {{ name }}', { name: 'Sam' })).toBe('Hi Sam');
        });
        it('supports dotted/dashed keys', () => {
            expect((0, template_render_1.renderTemplate)('{{first.name}}-{{order-id}}', { 'first.name': 'A', 'order-id': '7' })).toBe('A-7');
        });
        it('leaves an unknown placeholder literal', () => {
            expect((0, template_render_1.renderTemplate)('Hi {{name}}', {})).toBe('Hi {{name}}');
        });
        it('never renders a member of Object.prototype for a name with no variable of its own', () => {
            expect((0, template_render_1.renderTemplate)('{{constructor}} {{toString}} {{__proto__}}', {})).toBe('{{constructor}} {{toString}} {{__proto__}}');
        });
    });
    describe('legacy single-brace {name} (deprecated, still supported)', () => {
        it('substitutes a known placeholder', () => {
            expect((0, template_render_1.renderTemplate)('Hi {name}', { name: 'Sam' })).toBe('Hi Sam');
        });
        it('leaves an unknown placeholder literal', () => {
            expect((0, template_render_1.renderTemplate)('Hi {name}', {})).toBe('Hi {name}');
        });
    });
    describe('mixed + disambiguation', () => {
        it('substitutes both conventions in one string', () => {
            expect((0, template_render_1.renderTemplate)('{greeting}, {{name}}!', { greeting: 'Hello', name: 'Sam' })).toBe('Hello, Sam!');
        });
        it('does NOT mangle {{name}} into {value} (double-brace consumed as a unit)', () => {
            expect((0, template_render_1.renderTemplate)('{{name}}', { name: 'X' })).toBe('X');
        });
    });
    describe('edge cases', () => {
        it('returns an empty body unchanged', () => {
            expect((0, template_render_1.renderTemplate)('', { name: 'Sam' })).toBe('');
        });
        it('leaves non-placeholder braces untouched', () => {
            expect((0, template_render_1.renderTemplate)('a { b } c', { b: 'X' })).toBe('a { b } c'); // spaces => not a legacy placeholder
        });
        it('substitutes an explicitly-provided empty-string value', () => {
            // hasOwnProperty semantics: an explicit '' substitutes to '' (the legacy `||` renderer left it literal).
            expect((0, template_render_1.renderTemplate)('[{name}]', { name: '' })).toBe('[]');
        });
        it('renders a numeric value sent where a string was typed', () => {
            expect((0, template_render_1.renderTemplate)('#{{n}}', { n: 42 })).toBe('#42');
        });
        it('rejects a value that has no text form instead of throwing a TypeError', () => {
            const unprintable = { toString: 1 };
            expect(() => (0, template_render_1.renderTemplate)('{{v}}', { v: unprintable })).toThrow(template_render_1.TemplateRenderError);
            expect(() => (0, template_render_1.renderedLength)('{{v}}', { v: unprintable })).toThrow(template_render_1.TemplateRenderError);
            const noPrototype = Object.create(null);
            expect(() => (0, template_render_1.renderTemplate)('{v}', { v: noPrototype })).toThrow("Variable 'v' cannot be rendered as text");
        });
    });
});
describe('renderedLength', () => {
    const cases = [
        ['double and single braces', 'Hi {{name}}, {greeting}!', { name: 'Sam', greeting: 'Hello' }],
        ['spaced keys', '{{ first.name }}-{{order-id}}', { 'first.name': 'A', 'order-id': '1234567' }],
        ['a missing key stays literal', 'Hi {{name}} {other}', { name: 'Sam' }],
        ['a null value stays literal', 'x{{a}}y', { a: null }],
        ['a value shorter than its placeholder', '{{a_long_placeholder_name}}', { a_long_placeholder_name: '' }],
        ['non-placeholder braces', 'a { b } c {{ }}', { b: 'X' }],
        ['a body with no brace at all', 'plain text', { a: 'X' }],
        ['an empty body', '', { a: 'X' }],
    ];
    it.each(cases)('equals the length renderTemplate returns: %s', (_name, body, vars) => {
        expect((0, template_render_1.renderedLength)(body, vars)).toBe((0, template_render_1.renderTemplate)(body, vars).length);
    });
    it('measures an expansion too large to build without building it', () => {
        // 1365 single-brace placeholders fit in a 4 KiB body; a 1 MB value makes 1.4 billion characters, more than a
        // string can hold. A measure that built the text first would throw here instead of answering.
        const body = '{a}'.repeat(1365);
        const vars = { a: 'x'.repeat(1_000_000) };
        expect(() => (0, template_render_1.renderTemplate)(body, vars)).toThrow(RangeError);
        expect((0, template_render_1.renderedLength)(body, vars)).toBe(1365 * 1_000_000);
    });
});
describe('a variable that is not a string', () => {
    // A request may carry an array or object as a variable. Turning a large one into text for every repeat of
    // its placeholder would cost its size times the repeats before any limit is applied.
    const counting = () => {
        const toString = jest.fn(() => 'x'.repeat(10));
        return { toString, value: { toString } };
    };
    it('is turned into text once per render, however often its placeholder repeats', () => {
        const { toString, value } = counting();
        expect((0, template_render_1.renderTemplate)('{a}'.repeat(1000), { a: value })).toBe('x'.repeat(10_000));
        expect(toString).toHaveBeenCalledTimes(1);
    });
    it('is turned into text once per measurement, however often its placeholder repeats', () => {
        const { toString, value } = counting();
        expect((0, template_render_1.renderedLength)('{{a}}-'.repeat(1000), { a: value })).toBe(11_000);
        expect(toString).toHaveBeenCalledTimes(1);
    });
});
describe('templateVariableNames', () => {
    it.each([
        ['', []],
        ['no placeholders', []],
        ['Hi {{name}} and {name}', ['name', 'name']],
        ['{{ first.name }}-{{order-id}}-{plain}', ['first.name', 'order-id', 'plain']],
        ['{{}} { } {a b} {{a b}}', []],
    ])('lists the variables of %p', (body, names) => {
        expect((0, template_render_1.templateVariableNames)(body)).toEqual(names);
    });
    it('names exactly the placeholders the renderer substitutes', () => {
        const body = 'a {{x}} b {y} c {{ z.w }} d {{-}} e {not a var} f {{q}}{r}';
        const names = (0, template_render_1.templateVariableNames)(body);
        const vars = Object.fromEntries(names.map(name => [name, '#']));
        // Every listed name is replaced, and nothing else is: the unlisted braces are left as written.
        expect((0, template_render_1.renderTemplate)(body, vars)).toBe('a # b # c # d # e {not a var} f ##');
    });
});
