import type { Extracted } from './extract.ts';
import { Blocks, LIMITS, UserError } from './extract.ts';

// pdf.worker attaches itself to any worker global it is evaluated in (it would answer our own messages).
// Hide postMessage while it evaluates so it stays a plain module we drive in-process.
async function loadWorkerModule() {
  const scope = typeof self === 'undefined' ? null : self;
  // On a worker global, postMessage is an own property: save it and put it back exactly.
  const original = scope && Object.getOwnPropertyDescriptor(scope, 'postMessage');
  if (scope) Object.defineProperty(scope, 'postMessage', { value: undefined, configurable: true, writable: true });
  try {
    return await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  } finally {
    if (scope && original) Object.defineProperty(scope, 'postMessage', original);
    else if (scope) delete (scope as { postMessage?: unknown }).postMessage;
  }
}

type Line = { text: string; y: number; h: number; gapAbove: number };

const PAGE_TIMEOUT_MS = 2000;
const timeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new UserError('That file took too long. Try a smaller section or paste the text.')), ms))]);

// Text-layer extraction only: no rendering, fonts, annotations, forms or scripting.
export async function extractPdf(data: Uint8Array): Promise<Extracted> {
  if (data.length > LIMITS.fileBytes) throw new UserError('That file is over 20 MB. Try a smaller file or paste the text.');
  const g = globalThis as { pdfjsWorker?: unknown };
  // Run pdf.js on this (already off-main) thread: no second worker file, works from file:// too.
  // The legacy build supports the whole browser matrix (the modern build needs Promise.try etc.).
  g.pdfjsWorker ??= await loadWorkerModule();
  const pdfjs: typeof import('pdfjs-dist') = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
  const task = pdfjs.getDocument({
    data,
    useWasm: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const msg = (e as Error)?.name === 'PasswordException' ? 'That PDF is password-protected. Open it, copy the text and paste it here.' : "We couldn't read that PDF. Try saving it again, or paste the text.";
    throw new UserError(msg);
  }
  try {
    const pageCount = Math.min(doc.numPages, LIMITS.pdfPages);
    const pages: Line[][] = [];
    const emptyPages: number[] = [];
    for (let p = 1; p <= pageCount; p++) {
      const page = await timeout(doc.getPage(p), PAGE_TIMEOUT_MS);
      const content = await timeout(page.getTextContent(), PAGE_TIMEOUT_MS);
      const lines = toLines(content.items as { str?: string; transform?: number[]; height?: number; hasEOL?: boolean }[]);
      if (!lines.some(l => /[A-Za-z]{2}/.test(l.text))) emptyPages.push(p);
      pages.push(lines);
      page.cleanup();
    }
    return { blocks: toBlocks(pages), pages: pageCount, emptyPages };
  } finally {
    await task.destroy();
  }
}

function toLines(items: { str?: string; transform?: number[]; height?: number }[]): Line[] {
  const rows: { y: number; h: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const x = it.transform[4], y = it.transform[5], h = it.height || Math.abs(it.transform[3]) || 10;
    let row = rows.find(r => Math.abs(r.y - y) < h * 0.5);
    if (!row) rows.push((row = { y, h, parts: [] }));
    row.h = Math.max(row.h, h);
    row.parts.push({ x, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y); // PDF y grows upward
  return rows
    .map((r, i) => ({
      text: r.parts.sort((a, b) => a.x - b.x).map(p => p.s).join('').replace(/\s+/g, ' ').trim(),
      y: r.y,
      h: r.h,
      gapAbove: i ? rows[i - 1].y - r.y : 0,
    }))
    .filter(l => l.text);
}

const pageKey = (s: string) => s.toLowerCase().replace(/\d+/g, '#').trim();

export function toBlocks(pages: Line[][]): Blocks['list'] {
  // Drop running headers/footers (first/last line repeating on 3+ pages, digits ignored) and bare page numbers.
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const edge = new Set([lines[0], lines[lines.length - 1]].filter(Boolean).map(l => pageKey(l.text)));
    for (const k of edge) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const heights = pages.flat().map(l => l.h).sort((a, b) => a - b);
  const bodyH = heights[Math.floor(heights.length / 2)] || 10;
  const out = new Blocks();
  pages.forEach((lines, pi) => {
    let para = '';
    const flush = () => {
      if (para) out.add('paragraph', para, { page: pi + 1 });
      para = '';
    };
    lines.forEach((l, li) => {
      const edge = li === 0 || li === lines.length - 1;
      if (edge && (counts.get(pageKey(l.text)) ?? 0) >= 3 && pages.length >= 3) return;
      if (/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d+)?$/i.test(l.text)) return;
      if (l.h > bodyH * 1.2 && l.text.length < 90) { flush(); out.add('heading', l.text, { level: l.h > bodyH * 1.6 ? 1 : 2, page: pi + 1 }); return; }
      const bullet = l.text.match(/^\s*(?:[-*•▪●]|(\d{1,3})[.)])\s+/);
      if (bullet) { flush(); para = ''; out.add('listItem', l.text.slice(bullet[0].length), { page: pi + 1, ordered: !!bullet[1] }); return; }
      if (li && l.gapAbove > l.h * 1.8) flush();
      if (para.endsWith('-') && /^[a-z]/.test(l.text)) para = para.slice(0, -1) + l.text; // de-hyphenate line breaks
      else para = para ? para + ' ' + l.text : l.text;
    });
    flush();
  });
  return out.list;
}
