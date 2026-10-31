import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

// Nest's Logger prints through its own ConsoleLogger until main.js installs the app logger, and passes
// metadata objects on as the context name; createLogger() applies LOG_LEVEL, LOG_FORMAT, redaction and
// the request id everywhere. Shared with the controller block below, because a later block's
// no-restricted-syntax replaces this one's options instead of merging with them.
const NO_NEST_LOGGER = {
  selector: "NewExpression[callee.name='Logger']",
  message: 'Use createLogger() from common/services/logger.service instead of new Logger().',
};

export default [
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'node_modules/**', '.js-out/**'],
  },
  eslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      ecmaVersion: 2023,
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    files: ['src/**/*.js'],
    ignores: ['**/*.spec.js'],
    rules: {
      'no-restricted-syntax': ['error', NO_NEST_LOGGER],
    },
  },
  {
    // Architecture guard: HTTP controllers must go through a per-capability service and
    // never reach for the raw WhatsApp engine. This keeps the "session not started" guard,
    // error mapping, and business rules behind the service boundary instead of leaking into
    // controllers. `.getEngine(` (not `.getEngines()`), the EngineRegistry accessors, and the
    // `IWhatsAppEngine` type are banned.
    files: ['**/*.controller.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        NO_NEST_LOGGER,
        {
          selector: "CallExpression[callee.property.name='getEngine']",
          message:
            'Controllers must not call getEngine(). Add a method to the capability service (e.g. GroupService) and call that instead.',
        },
        {
          // EngineRegistry.require()/get() resolve a live engine, so reaching for either from a
          // controller bypasses the capability service exactly as getEngine() used to. Matches
          // `this.engines.require(...)` (a MemberExpression callee object) as well as a bare
          // `engines.require(...)`.
          selector:
            "CallExpression[callee.property.name=/^(require|get)$/]:has(MemberExpression[property.name='engines'])",
          message:
            'Controllers must not resolve an engine from EngineRegistry. Add a method to the capability service and call that instead.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/engine/interfaces/whatsapp-engine.interface'],
              importNames: ['IWhatsAppEngine'],
              message:
                'Controllers must not import IWhatsAppEngine. Keep engine types behind a capability service.',
            },
            {
              group: ['**/engine/engine-registry.service'],
              message:
                'Controllers must not import EngineRegistry. Keep engine access behind a capability service.',
            },
          ],
        },
      ],
    },
  },
];
