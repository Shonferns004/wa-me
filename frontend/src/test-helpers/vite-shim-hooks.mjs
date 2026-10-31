// ESM customization hooks letting the bare `node --test` runner load the dashboard's Vite-style
// sources:
//   - .jsx            → transpiled with the project's own TypeScript (jsx: react-jsx); Node has no
//                       JSX parser, so this is the only way to load a component test
//   - extensionless relative imports → resolved by trying .jsx/.js/.mjs/.json/.tsx/.ts (and /index.*)
//   - .json           → wrapped as `export default` (Node would demand import attributes)
//   - .css            → stubbed as an empty module
//   - .svg/.png/.jpg/.webp → stubbed as `export default '<url>'` (Vite resolves an asset import to
//     its URL string; Node has no loader for these extensions at all)
//   - sources reading import.meta.env → seeded with `import.meta.env ??= {}` (import.meta.env is a
//     Vite global Node does not provide)
//   - .ts/.tsx        → still handled: a handful of dashboard tests reach across into the TypeScript
//     backend (bundled-host, template-render) and import those files directly.
//
// Registered via test-helpers/register-hooks.js. node:test runs each test file in its own child
// process, so these hooks only ever affect the component smoke-test process — the pure-logic
// tests never register them.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const RESOLVE_EXTENSIONS = ['.jsx', '.js', '.mjs', '.json', '.tsx', '.ts'];

// socket.io-client is swapped for a double that never dials — see test-helpers/socket-io-double.js.
const SOCKET_DOUBLE = new URL('./socket-io-double.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'socket.io-client') return { url: SOCKET_DOUBLE, shortCircuit: true };
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // Only patch up relative specifiers (Vite resolves these extensionless; Node does not).
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw error;
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = base + ext;
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = path.join(base, `index${ext}`);
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    throw error;
  }
}

const ENV_SHIM = 'import.meta.env ??= {};\n';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  if (url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.webp')) {
    // Vite resolves an asset import to its URL string. The tests never read the bytes; they only
    // need the import to succeed and the value to be a string an <img src> can take.
    return { format: 'module', source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
  }
  if (url.endsWith('.json')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', source: `export default ${source};`, shortCircuit: true };
  }
  if (url.endsWith('.jsx')) {
    return { format: 'module', source: await transpile(url), shortCircuit: true };
  }
  if (url.endsWith('.tsx')) {
    return { format: 'module', source: await transpile(url), shortCircuit: true };
  }
  if (url.endsWith('.ts')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    if (!source.includes('import.meta.env')) return nextLoad(url, context);
    return { format: 'module', source: await transpile(url, source), shortCircuit: true };
  }
  if (url.endsWith('.js')) {
    // Native ESM, but `import.meta.env` only exists under Vite: seed it before the module body runs.
    const source = await readFile(fileURLToPath(url), 'utf8');
    if (!source.includes('import.meta.env')) return nextLoad(url, context);
    return { format: 'module', source: ENV_SHIM + source, shortCircuit: true };
  }
  return nextLoad(url, context);
}

async function transpile(url, presetSource) {
  const fileName = fileURLToPath(url);
  const source = presetSource ?? (await readFile(fileName, 'utf8'));
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName,
  });
  // import.meta is extensible; seeding `env` keeps Vite-style `import.meta.env.X` reads working.
  const shim = source.includes('import.meta.env') ? ENV_SHIM : '';
  return shim + outputText;
}
