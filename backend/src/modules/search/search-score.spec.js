"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const search_score_1 = require("./search-score");
describe('containsScore', () => {
    it('scores a whole word above a word start above a match inside a word', () => {
        expect((0, search_score_1.containsScore)('Please pay the invoice today', ['invoice'])).toBe(3);
        expect((0, search_score_1.containsScore)('Invoiced orders are listed below', ['invoice'])).toBe(2);
        expect((0, search_score_1.containsScore)('Reinvoice requested', ['invoice'])).toBe(1);
    });
    it('keeps the best occurrence of a term', () => {
        expect((0, search_score_1.containsScore)('reinvoice, then invoice', ['invoice'])).toBe(3);
    });
    it('ignores case and accents, and treats punctuation as a word boundary', () => {
        expect((0, search_score_1.containsScore)('Meeting at the CAFÉ.', ['cafe'])).toBe(3);
        expect((0, search_score_1.containsScore)('INV-2048 is ready', ['2048'])).toBe(3);
    });
    it('adds the scores of all terms', () => {
        expect((0, search_score_1.containsScore)('Your invoice INV-2048 is ready', ['invoice', '2048'])).toBe(6);
        expect((0, search_score_1.containsScore)('Thanks, I will pay the invoice today', ['invoice', 'to'])).toBe(5);
    });
    it('reads final sigma as sigma, whichever side writes it', () => {
        expect((0, search_score_1.containsScore)('ΚΑΛΟΣ ΔΡΟΜΟΣ σήμερα', ['δρομος'])).toBe(3);
        expect((0, search_score_1.containsScore)('ΚΑΛΟΣ ΔΡΟΜΟΣ σήμερα', ['δρομοσ'])).toBe(3);
    });
    it('scores 0 for a term the body does not contain', () => {
        expect((0, search_score_1.containsScore)('Order shipped', ['invoice'])).toBe(0);
    });
});
