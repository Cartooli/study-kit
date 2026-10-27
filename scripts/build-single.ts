// Builds the single-file edition: study-kit.html runs from file:// with no network, no service worker.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { build } from 'vite';
import { thirdPartyNotices } from './notices.ts';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

await build({ mode: 'single', logLevel: 'warn' });
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: 'dist-single/worker',
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: 'src/parse.worker.ts', formats: ['iife'], name: 'StudyKitWorker', fileName: () => 'worker.js' },
    // pdf.js only reads import.meta.url to find a worker file; we hand it the worker in-process instead.
    rolldownOptions: { output: { codeSplitting: false }, transform: { define: { 'import.meta': '{}' } } },
  },
});

const read = (dir: string, ext: string) => {
  const files = readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith(ext));
  if (files.length !== 1) throw new Error(`Expected one ${ext} in ${dir}, found ${files.length}`);
  return readFileSync(`${dir}/${files[0]}`, 'utf8');
};
// Script element raw text ends at "</script"; "<!--" can change how it is parsed. Neither may appear unescaped.
const inline = (code: string) => {
  const out = code.replace(/<\/script/gi, '<\\/script');
  if (out.includes('<!--')) throw new Error('Bundle contains "<!--"; cannot inline safely');
  return out;
};
const js = inline(read('dist-single/app/assets', '.js'));
const css = read('dist-single/app/assets', '.css');
const worker = inline(read('dist-single/worker', '.js'));
const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

const csp = [
  "default-src 'none'",
  `script-src ${sha(js)}`,
  `style-src ${sha(css)}`,
  "img-src data: blob:",
  'worker-src blob:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types studykit',
].join('; ');
const icon = `data:image/svg+xml;base64,${readFileSync('public/icons/icon.svg').toString('base64')}`;

let html = readFileSync('dist-single/app/index.html', 'utf8')
  .replace(/\s*<script type="module"[^>]*><\/script>/, '')
  .replace(/\s*<link rel="stylesheet"[^>]*>/, '')
  .replace(/\s*<link rel="(manifest|icon|apple-touch-icon)"[^>]*>/g, '')
  .replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <link rel="icon" href="${icon}" />`);
html = html.replace('</head>', () => `  <style>${css}</style>\n  </head>`);
html = html.replace('</body>', () => `  <script type="text/plain" id="sk-worker">${worker}</script>\n    <script type="module">${js}</script>\n  </body>`);

mkdirSync('release', { recursive: true });
writeFileSync('release/study-kit.html', html);
const readme = `Study Kit ${version} — single-file edition

Double-click study-kit.html to open it in your browser. It works with no internet connection
and never sends anything anywhere. Built by rules, not AI.

Your study sets are saved in this browser when it allows that. If you see a banner saying the
browser won't remember your cards, use "Save progress file" before closing, and "Open progress
file" (in Settings) next time.

Scanned pages and photos need a scan reader, which this edition does not include.
Check for updates at studyspine.org/study-kit.

Free for students, families, teachers and schools under the PolyForm Noncommercial
License 1.0.0 (LICENSE.txt). Commercial use needs a license from MLN Learning LLC.
`;
const zip = zipSync({
  'study-kit/study-kit.html': new TextEncoder().encode(html),
  'study-kit/README.txt': new TextEncoder().encode(readme),
  'study-kit/LICENSE.txt': readFileSync('LICENSE'),
  'study-kit/THIRD-PARTY-NOTICES.txt': new TextEncoder().encode(thirdPartyNotices()),
}, { mtime: new Date('2026-01-01T00:00:00Z') }); // fixed mtime keeps the zip reproducible
const zipName = `study-kit-v${version}.zip`;
writeFileSync(`release/${zipName}`, zip);
const sum = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
writeFileSync('release/SHA256SUMS', `${sum(html)}  study-kit.html\n${sum(zip)}  ${zipName}\n`);
console.log(`release/study-kit.html ${(html.length / 1024).toFixed(0)} KB, release/${zipName} ${(zip.length / 1024).toFixed(0)} KB`);
