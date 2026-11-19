// Release gates (§12, §16): license allowlist, size budgets, copy check. Run after both builds.
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CSP } from '../csp.ts';

const fail: string[] = [];

// 1. Licenses: every production package must be on the allowlist.
const ALLOW = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|CC0-1\.0|OFL-1\.1|0BSD)$/;
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; dependencies: Record<string, string> };
const prod = (JSON.parse(execSync('npm query ".prod"', { encoding: 'utf8' })) as { name: string; version: string; license?: string }[]).filter(p => p.name !== pkg.name);
for (const p of prod) if (!ALLOW.test(p.license ?? '')) fail.push(`license: ${p.name}@${p.version} is "${p.license}"`);
const direct = Object.entries(pkg.dependencies);
if (direct.length > 7) fail.push(`dependencies: ${direct.length} runtime packages > 7`);
for (const [n, v] of direct) if (!/^\d+\.\d+\.\d+$/.test(v)) fail.push(`dependencies: ${n} is not pinned to an exact version (${v})`);

// 2. Budgets (gzip KB): shell ≤ 250 excluding the PDF pack; hosted precache ≤ 900; single file ≤ 4 MB raw.
const walk = (d: string): string[] => readdirSync(d).flatMap(f => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const gz = (f: string) => gzipSync(readFileSync(f)).length / 1024;
const hosted = walk('dist').filter(f => !f.endsWith('.png'));
const pdfPack = hosted.filter(f => /\/pdf\.(worker\.)?min-/.test(f));
const shell = hosted.filter(f => !pdfPack.includes(f)).reduce((n, f) => n + gz(f), 0);
const total = walk('dist').reduce((n, f) => n + gz(f), 0);
const single = statSync('release/study-kit.html').size / 1048576;
console.log(`budgets: shell ${shell.toFixed(0)} KB gz, precache ${total.toFixed(0)} KB gz, single file ${single.toFixed(2)} MB`);
if (!pdfPack.length) fail.push('budget: PDF pack chunks not found (did chunk names change?)');
if (shell > 250) fail.push(`budget: app shell ${shell.toFixed(0)} KB gz > 250`);
if (total > 900) fail.push(`budget: precache ${total.toFixed(0)} KB gz > 900`);
if (single > 4) fail.push(`budget: single file ${single.toFixed(2)} MB > 4`);

// 3. Copy check (acceptance 12): no exam, premium or AI-tutor language in UI strings or metadata.
const copy = [...walk('src').filter(f => /\.(tsx|ts|html|css)$/.test(f) && !f.includes('/engine/')), 'index.html', 'public/manifest.webmanifest', 'scripts/build-single.ts'];
for (const f of copy) {
  const t = readFileSync(f, 'utf8');
  const hit = t.match(/\b(SAT|ACT|MAP Growth|CAASPP|CogAT|NNAT|Premium|Know It All)\b/) ?? t.replace(/built by rules, not AI/gi, '').match(/tutor|AI-generated|AI-powered/i);
  if (hit) fail.push(`copy: "${hit[0]}" in ${f}`);
}

// 3b. Document text is only ever rendered as text nodes.
for (const f of walk('src')) if (/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write/.test(readFileSync(f, 'utf8'))) fail.push(`xss: HTML sink in ${f}`);

// 4. No network: the built app must not reference any other origin.
// Canonical and Open Graph tags may name the hosted origin; they are not fetches.
for (const f of [...hosted.filter(f => /\.(js|html|css)$/.test(f)), 'release/study-kit.html']) {
  const t = readFileSync(f, 'utf8').replace(/<link\s+rel=["']canonical["'][^>]*>/gi, '');
  if (/\bfetch\(\s*["'`]https?:/.test(t) || /<(script|link)[^>]+(src|href)=["']https?:/.test(t)) fail.push(`network: external reference in ${f}`);
}

// 5. The hosting header must carry the same CSP the page mirrors.
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] };
if (vercel.headers[0].headers.find(h => h.key === 'Content-Security-Policy')?.value !== CSP.join('; ')) fail.push('csp: vercel.json differs from csp.ts');

if (fail.length) {
  console.error(fail.join('\n'));
  process.exit(1);
}
console.log(`checks passed: ${prod.length} production packages, all allowlisted`);
