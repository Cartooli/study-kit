import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { META_CSP } from './csp.ts';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

// Emits sw.js with the full precache list for this release, and mirrors the CSP into a <meta>.
function hostedShell(): Plugin {
  return {
    name: 'studykit-shell',
    apply: 'build',
    transformIndexHtml: html => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${META_CSP}" />`),
    generateBundle(_, bundle) {
      const files = [...new Set(['/', '/index.html', ...Object.keys(bundle).filter(f => f !== 'index.html').map(f => '/' + f), ...walk('public').map(f => '/' + relative('public', f).split('\\').join('/'))])].sort();
      // Asset names carry content hashes, so any code change gets a fresh cache even without a version bump.
      const build = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 10);
      const sw = readFileSync('src/sw.js', 'utf8').replace("'__VERSION__'", JSON.stringify(`${version}-${build}`)).replace('[/*__FILES__*/]', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
    },
  };
}

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    define: { __APP_VERSION__: JSON.stringify(version) },
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    plugins: single ? [] : [hostedShell()],
    resolve: single ? { alias: [{ find: /^\.\/worker-url\.ts$/, replacement: join(import.meta.dirname, 'src/worker-url.single.ts') }] } : {},
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      outDir: single ? 'dist-single/app' : 'dist',
      emptyOutDir: true,
      modulePreload: { polyfill: false },
      assetsInlineLimit: single ? 100_000_000 : 0,
      cssCodeSplit: !single,
      copyPublicDir: !single,
      rolldownOptions: single ? { output: { codeSplitting: false } } : {},
    },
  };
});
