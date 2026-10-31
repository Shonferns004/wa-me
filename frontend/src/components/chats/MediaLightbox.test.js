// Render test for the lightbox download name. The caption is message text, not a file name, and an
// empty name makes the library open the image in a new tab instead of saving it.
import '../../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
let rtl;
let MediaLightbox;
before(async () => {
    const { installJsdomGlobals } = await import('../../test-helpers/jsdom.js');
    await installJsdomGlobals();
    rtl = await import('@testing-library/react');
    ({ default: MediaLightbox } = await import('./MediaLightbox.jsx'));
});
afterEach(() => {
    rtl.cleanup();
});
/** Press Download and return the name the library gave the link it clicked. */
function downloadName(item) {
    const noop = () => { };
    rtl.render(createElement(MediaLightbox, { items: [item], index: 0, onClose: noop, onNavigate: noop }));
    const button = rtl.screen.getByRole('button', { name: 'Download' });
    const links = [];
    const createElementOriginal = document.createElement;
    document.createElement = ((tag, options) => {
        const element = createElementOriginal.call(document, tag, options);
        if (tag === 'a') {
            // Stop the synthetic click from navigating jsdom; only the name matters here.
            element.dispatchEvent = () => true;
            links.push(element);
        }
        return element;
    });
    try {
        rtl.fireEvent.click(button);
    }
    finally {
        document.createElement = createElementOriginal;
    }
    assert.equal(links.length, 1, 'expected one download link');
    return links[0].download;
}
const IMAGE = { id: 'm1', url: 'http://localhost/media/m1' };
test('a captioned image downloads under its file name, not its caption', () => {
    assert.equal(downloadName({ ...IMAGE, alt: 'Look at this!', filename: 'photo.png' }), 'photo.png');
});
test('an image with no file name falls back to a generated name, captioned or not', () => {
    assert.equal(downloadName({ ...IMAGE, alt: 'Look at this!' }), 'image-m1.jpg');
    rtl.cleanup();
    assert.equal(downloadName({ ...IMAGE, alt: '' }), 'image-m1.jpg');
});
