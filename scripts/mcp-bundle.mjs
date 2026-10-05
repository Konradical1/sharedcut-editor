// Build the standalone SharedCut MCP: two files (server.mjs, setup.mjs) a user runs without the SharedCut source.
// Only @napi-rs/canvas (native, per platform) stays an npm dependency.
//
//   node scripts/mcp-bundle.mjs [outDir]      (default dist-mcp)
import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), out = resolve(process.argv[2] ?? join(root, 'dist-mcp'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// The app files help reads catalogs from at runtime (mcp/env.ts appFile).
const sources = Object.fromEntries(['src/state/store.ts', 'src/components/SettingsDialog.tsx', 'src/workspaces/ColorWorkspace.tsx', 'src/services/color.ts']
  .map(path => [path, readFileSync(join(root, path), 'utf8')]));
mkdirSync(out, { recursive: true });
await build({
  entryPoints: { server: join(root, 'mcp/server.ts'), setup: join(root, 'mcp/setup.ts') },
  outdir: out, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true,
  external: ['@napi-rs/canvas'], logLevel: 'warning',
  banner: { js: `import { createRequire as __req } from 'node:module'; const require = __req(import.meta.url); globalThis.__SHAREDCUT_SOURCES__ = ${JSON.stringify(sources)};` },
});
// No "install" script: npm would run it on every npm install.
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'sharedcut-mcp', version: pkg.version, private: true, type: 'module', engines: { node: '>=22.18' },
  scripts: { setup: 'node setup.mjs setup', login: 'node setup.mjs login', register: 'node setup.mjs install', start: 'node server.mjs' },
  dependencies: { '@napi-rs/canvas': pkg.dependencies['@napi-rs/canvas'] },
}, null, 2) + '\n');
console.log(`SharedCut MCP ${pkg.version} → ${out}`);
