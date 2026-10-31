'use strict';

/**
 * Babel configuration used only by Jest (babel-jest). The application itself runs as plain
 * CommonJS on Node and never loads this file.
 *
 * ts-jest used to downlevel dynamic `import()` to a `require()` wrapped in the `__importStar`
 * interop helper. That is what let Jest's `moduleNameMapper` and `jest.mock` factories intercept an
 * ESM-only dependency such as `@whiskeysockets/baileys`, and it is what made `(await
 * import('sharp')).default` resolve for a CommonJS package. The JavaScript source keeps native
 * `import()` (production needs Node's real ESM loader), and Jest's VM refuses it unless the process
 * runs with `--experimental-vm-modules`. This plugin restores the previous test behaviour by
 * performing the same downlevel for test runs only.
 */
const template = require('@babel/template').default;
const t = require('@babel/types');

/** `__importStar(require(specifier))`, inlined so the transform needs no runtime helper. */
const importStarBody = template.statements(`
  var __mod = require(SPECIFIER);
  if (__mod && __mod.__esModule) return __mod;
  var __ns = { default: __mod };
  if (__mod != null) {
    Object.keys(__mod).forEach(function (key) {
      if (key !== 'default') __ns[key] = __mod[key];
    });
  }
  return __ns;
`);

function dynamicImportToRequire() {
  return {
    name: 'dynamic-import-to-require',
    visitor: {
      CallExpression(path) {
        if (path.node.callee.type !== 'Import') return;
        const [specifier] = path.node.arguments;
        const body = importStarBody({ SPECIFIER: specifier });
        path.replaceWith(
          t.callExpression(t.memberExpression(t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('resolve')), []), t.identifier('then')), [t.arrowFunctionExpression([], t.blockStatement(body))]),
        );
      },
    },
  };
}

module.exports = {
  plugins: [dynamicImportToRequire],
};
