import { unzipSync } from 'fflate';
import type { Block, BlockKind } from '../types.ts';
import { normalize } from './text.ts';

export const LIMITS = {
  textChars: 300_000,
  fileBytes: 20 * 1024 * 1024,
  zipTotal: 50 * 1024 * 1024,
  zipEntries: 500,
  zipRatio: 100,
  pdfPages: 200,
};

export class UserError extends Error {}

export class Blocks {
  list: Block[] = [];
  chars = 0;
  add(kind: BlockKind, raw: string, extra: Partial<Block> = {}) {
    const text = normalize(raw);
    if (!text) return;
    this.chars += text.length;
    if (this.chars > LIMITS.textChars) throw new UserError('That text is over 300,000 characters. Try a smaller section.');
    this.list.push({ id: 'b' + this.list.length, kind, text, order: this.list.length, ...extra });
  }
}

export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const BULLET = /^\s*(?:[-*+•▪●–]|(\d{1,3}|[a-zA-Z])[.)])\s+/;

// Plain text and markdown share one reader: markdown structure is read, never rendered.
export function parseText(input: string): Block[] {
  if (input.length > LIMITS.textChars) throw new UserError('That text is over 300,000 characters. Try a smaller section.');
  const out = new Blocks();
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let fence = false;
  const flush = () => {
    if (para.length) out.add('paragraph', para.join(' '));
    para = [];
  };
  const inline = (s: string) =>
    s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|`)/g, '').replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, '$1$2');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) { flush(); fence = !fence; continue; }
    if (fence) { para.push(t); continue; }
    if (!t) { flush(); continue; }
    let m;
    if ((m = t.match(/^(#{1,6})\s+(.+?)#*$/))) { flush(); out.add('heading', inline(m[2]), { level: m[1].length }); continue; }
    if (/^(=+|-+)$/.test(t) && para.length === 1) { out.add('heading', inline(para[0]), { level: t[0] === '=' ? 1 : 2 }); para = []; continue; }
    if (/^\|.*\|$/.test(t)) {
      flush();
      if (/^\|[\s:|-]+\|$/.test(t)) continue;
      out.add('tableRow', t.slice(1, -1).split('|').map(c => inline(c.trim())).filter(Boolean).join(' — '));
      continue;
    }
    if ((m = t.match(BULLET))) {
      flush();
      out.add('listItem', inline(t.slice(m[0].length).replace(/^\[[ xX]\]\s*/, '')), { ordered: !!m[1] && /\d/.test(m[1]) });
      continue;
    }
    // Plain-text heading: a short line with no end punctuation, standing alone before more text.
    const next = lines[i + 1]?.trim() ?? '';
    if (!para.length && t.length <= 70 && t.split(/\s+/).length <= 10 && !/[.,;:!?"')]$/.test(t) && /^[A-Z0-9]/.test(t) && (!next || /^[A-Z0-9"'(]/.test(next) || BULLET.test(next))) {
      out.add('heading', inline(t), { level: t === t.toUpperCase() && /[A-Z]/.test(t) ? 1 : 2 });
      continue;
    }
    para.push(inline(t));
  }
  flush();
  return out.list;
}

// --- Office files ---------------------------------------------------------

function unzipParts(data: Uint8Array, want: (name: string) => boolean): Record<string, Uint8Array> {
  if (data.length > LIMITS.fileBytes) throw new UserError('That file is over 20 MB. Try a smaller file or paste the text.');
  let entries = 0, total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter(f) {
        entries++;
        total += f.originalSize;
        if (entries > LIMITS.zipEntries || total > LIMITS.zipTotal || (f.size > 0 && f.originalSize / f.size > LIMITS.zipRatio))
          throw new UserError("That file looks damaged or unusually packed, so we didn't open it.");
        return want(f.name);
      },
    });
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError("We couldn't open that file. Save it again as DOCX or PDF, or paste the text.");
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e] ?? m;
  });

type XmlEvent = { open?: string; close?: string; attrs?: string; text?: string };

// Minimal XML token scanner (DOMParser isn't available inside workers). Only reads named parts we asked for.
export function* scanXml(xmlBytes: Uint8Array): Generator<XmlEvent> {
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  if (/<!DOCTYPE/i.test(xml)) throw new UserError("That file contains something we don't read, so we didn't open it.");
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)|<[?!][^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) yield { text: decodeEntities(m[5]) };
    else if (m[2]) {
      if (m[1]) yield { close: m[2] };
      else {
        yield { open: m[2], attrs: m[3] };
        if (m[4]) yield { close: m[2] };
      }
    }
  }
}

const attr = (attrs: string | undefined, name: string) => attrs?.match(new RegExp(`${name}="([^"]*)"`))?.[1];

export function parseDocx(data: Uint8Array): Block[] {
  const parts = unzipParts(data, n => n === 'word/document.xml' || n === 'word/footnotes.xml');
  if (!parts['word/document.xml']) throw new UserError("That doesn't look like a Word document. Save it as DOCX or PDF, or paste the text.");
  const out = new Blocks();
  for (const name of ['word/document.xml', 'word/footnotes.xml']) {
    if (!parts[name]) continue;
    let text = '', style = '', numbered = false, inTable = 0, cells: string[] = [], cell = '', inText = false;
    for (const ev of scanXml(parts[name])) {
      if (ev.open === 'w:p') { text = ''; style = ''; numbered = false; }
      else if (ev.open === 'w:pStyle') style = attr(ev.attrs, 'w:val') ?? '';
      else if (ev.open === 'w:numPr') numbered = true;
      else if (ev.open === 'w:t') inText = true;
      else if (ev.close === 'w:t') inText = false;
      else if (ev.open === 'w:tab') text += ' ';
      else if (ev.open === 'w:br' || ev.open === 'w:cr') text += ' ';
      else if (ev.text !== undefined && inText) text += ev.text;
      else if (ev.open === 'w:tbl') inTable++;
      else if (ev.close === 'w:tbl') inTable--;
      else if (ev.open === 'w:tr') cells = [];
      else if (ev.open === 'w:tc') cell = '';
      else if (ev.close === 'w:tc') cells.push(cell.trim());
      else if (ev.close === 'w:tr') out.add('tableRow', cells.filter(Boolean).join(' — '));
      else if (ev.close === 'w:p') {
        if (inTable) { cell += ' ' + text; continue; }
        const h = style.match(/^(?:Heading|heading)\s?(\d)$/) ?? (style === 'Title' ? ['', '1'] : null);
        if (h) out.add('heading', text, { level: +h[1] });
        else if (/^Caption$/i.test(style)) out.add('caption', text);
        else if (numbered || /List/i.test(style)) out.add('listItem', text, { ordered: /Number/i.test(style) || numbered });
        else out.add('paragraph', text);
      }
    }
  }
  return out.list;
}

export function parsePptx(data: Uint8Array): Block[] {
  const parts = unzipParts(data, n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const names = Object.keys(parts).sort((a, b) => +a.match(/\d+/)![0] - +b.match(/\d+/)![0]);
  if (!names.length) throw new UserError("That doesn't look like a PowerPoint file. Save it as PDF, or paste the text.");
  const out = new Blocks();
  names.forEach((name, i) => {
    let isTitle = false, para = '', inText = false, gotTitle = false;
    for (const ev of scanXml(parts[name])) {
      if (ev.open === 'p:sp') isTitle = false;
      else if (ev.open === 'p:ph') isTitle = /type="(title|ctrTitle)"/.test(ev.attrs ?? '');
      else if (ev.open === 'a:p') para = '';
      else if (ev.open === 'a:t') inText = true;
      else if (ev.close === 'a:t') inText = false;
      else if (ev.open === 'a:br') para += ' ';
      else if (ev.text !== undefined && inText) para += ev.text;
      else if (ev.close === 'a:p') {
        if (isTitle) { out.add('heading', para, { level: 2, page: i + 1 }); gotTitle = true; }
        else out.add(gotTitle ? 'listItem' : 'paragraph', para, { page: i + 1 });
      }
    }
  });
  return out.list;
}

export type Extracted = { blocks: Block[]; pages?: number; emptyPages?: number[] };

export function kindOf(name: string, mime: string): 'text' | 'docx' | 'pptx' | 'pdf' | 'image' | 'unsupported' {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (['txt', 'md', 'markdown', 'text'].includes(ext) || mime.startsWith('text/')) return 'text';
  if (['png', 'jpg', 'jpeg'].includes(ext)) return 'image';
  return 'unsupported';
}
