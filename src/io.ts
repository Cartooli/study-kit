import type { Deck, Item, Source } from './types.ts';
import { ITEM_TYPES } from './types.ts';

export const SCHEMA_VERSION = 1;
export const IMPORT_MAX_BYTES = 25 * 1024 * 1024;
export const STORES = ['sources', 'items', 'decks', 'srs', 'reviewLog', 'tests'] as const;
export type StoreName = (typeof STORES)[number] | 'settings';

export type SrsCard = {
  itemId: string; due: Date; stability: number; difficulty: number; elapsed_days: number; scheduled_days: number;
  learning_steps: number; reps: number; lapses: number; state: number; last_review?: Date; suspended?: boolean;
};
export type ReviewLog = { id?: number; itemId: string; rating: number; state: number; due: Date; reviewedAt: Date; elapsedMs: number };
export type TestRecord = { id: string; deckId: string; seed: number; config: Record<string, unknown>; attempts: { startedAt: number; finishedAt: number; answers: unknown[]; score: number }[] };

export type Bundle = { sources: Source[]; items: Item[]; decks: Deck[]; srs: SrsCard[]; reviewLog: ReviewLog[]; tests: TestRecord[] };

export function exportJson(b: Bundle): string {
  return JSON.stringify({ format: 'studykit', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...b });
}

// --- Import validation (§10): JSON.parse only, hand-written schema, unknown fields dropped. ---

class Bad extends Error {}
const MAX_STR = 20_000;
const BANNED = new Set(['__proto__', 'constructor', 'prototype']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_STR): string => {
  if (typeof v !== 'string' || v.length > max) throw new Bad('text');
  return v;
};
const optStr = (v: unknown, max = MAX_STR) => (v === undefined || v === null ? undefined : str(v, max));
const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Bad('number');
  return v;
};
const optNum = (v: unknown) => (v === undefined || v === null ? undefined : num(v));
const date = (v: unknown): Date => {
  const d = new Date(typeof v === 'string' || typeof v === 'number' ? v : NaN);
  if (isNaN(+d)) throw new Bad('date');
  return d;
};
const arr = <T>(v: unknown, f: (x: unknown) => T, max = 100_000): T[] => {
  if (!Array.isArray(v) || v.length > max) throw new Bad('list');
  return v.map(f);
};
const oneOf = <T extends string>(v: unknown, opts: readonly T[]): T => {
  if (!opts.includes(v as T)) throw new Bad('value');
  return v as T;
};

function block(v: unknown) {
  if (!isObj(v)) throw new Bad('block');
  return {
    id: str(v.id, 64), kind: oneOf(v.kind, ['heading', 'paragraph', 'listItem', 'tableRow', 'caption'] as const), level: optNum(v.level),
    text: str(v.text), page: optNum(v.page), order: num(v.order), ordered: v.ordered === true ? true : undefined,
  };
}

function payload(type: string, v: unknown): Item['payload'] {
  if (!isObj(v)) throw new Bad('payload');
  switch (type) {
    case 'flash': return { t: 'flash', front: str(v.front), back: str(v.back) };
    case 'cloze': return { t: 'cloze', text: str(v.text), answer: str(v.answer), hint: str(v.hint ?? ''), context: optStr(v.context) };
    case 'mcq': return { t: 'mcq', stem: str(v.stem), answer: str(v.answer), pool: arr(v.pool, x => str(x), 20) };
    case 'tf': return { t: 'tf', statement: str(v.statement), answer: v.answer === true, original: str(v.original) };
    case 'match': return { t: 'match', pairs: arr(v.pairs, p => { const a = arr(p, x => str(x), 2); if (a.length !== 2) throw new Bad('pair'); return [a[0], a[1]] as [string, string]; }, 20) };
    case 'sequence': return { t: 'sequence', prompt: str(v.prompt), steps: arr(v.steps, x => str(x), 20) };
    case 'explain': return { t: 'explain', prompt: str(v.prompt), answer: str(v.answer) };
    case 'selfcheck': return { t: 'selfcheck', question: str(v.question) };
  }
  throw new Bad('type');
}

const V = {
  sources(v: unknown): Source {
    if (!isObj(v) || !isObj(v.stats)) throw new Bad('source');
    return {
      id: str(v.id, 64), title: str(v.title, 300), fileName: str(v.fileName ?? '', 300), mime: str(v.mime ?? '', 100), sizeBytes: num(v.sizeBytes ?? 0),
      textHash: str(v.textHash ?? '', 128), docType: oneOf(v.docType, ['lesson', 'reading', 'essay', 'notes', 'homework', 'math'] as const),
      blocks: arr(v.blocks, block, 50_000),
      stats: { words: num(v.stats.words), sentences: num(v.stats.sentences), minutes: num(v.stats.minutes), pages: optNum(v.stats.pages) },
      createdAt: num(v.createdAt),
      // Restatements are recomputed by the app, not trusted from a file.
    };
  },
  items(v: unknown): Item {
    if (!isObj(v) || !isObj(v.sourceRef)) throw new Bad('item');
    const type = oneOf(v.type, ITEM_TYPES);
    return {
      id: str(v.id, 64), sourceId: str(v.sourceId, 64), type, payload: payload(type, v.payload), confidence: num(v.confidence),
      sourceRef: { blockId: str(v.sourceRef.blockId, 64), sentenceIdx: num(v.sourceRef.sentenceIdx), text: str(v.sourceRef.text), context: optStr(v.sourceRef.context) },
      status: oneOf(v.status, ['active', 'hidden', 'deleted', 'edited'] as const), seed: num(v.seed), createdAt: num(v.createdAt), editedAt: optNum(v.editedAt),
    };
  },
  decks(v: unknown): Deck {
    if (!isObj(v) || !isObj(v.settings)) throw new Bad('deck');
    const s = v.settings;
    return {
      id: str(v.id, 64), title: str(v.title, 300), sourceIds: arr(v.sourceIds, x => str(x, 64), 1000), itemIds: arr(v.itemIds, x => str(x, 64)),
      settings: {
        types: arr(s.types, x => oneOf(x, ITEM_TYPES), 8), count: oneOf(String(s.count), ['auto', '10', '20', '40'] as const) === 'auto' ? 'auto' : (Number(s.count) as 10 | 20 | 40),
        difficulty: oneOf(s.difficulty, ['recall', 'recognition'] as const), seed: num(s.seed),
      },
      createdAt: num(v.createdAt), updatedAt: num(v.updatedAt),
    };
  },
  srs(v: unknown): SrsCard {
    if (!isObj(v)) throw new Bad('srs');
    return {
      itemId: str(v.itemId, 64), due: date(v.due), stability: num(v.stability), difficulty: num(v.difficulty), elapsed_days: num(v.elapsed_days),
      scheduled_days: num(v.scheduled_days), learning_steps: num(v.learning_steps ?? 0), reps: num(v.reps), lapses: num(v.lapses), state: num(v.state),
      last_review: v.last_review ? date(v.last_review) : undefined, suspended: v.suspended === true ? true : undefined,
    };
  },
  reviewLog(v: unknown): ReviewLog {
    if (!isObj(v)) throw new Bad('log');
    return { itemId: str(v.itemId, 64), rating: num(v.rating), state: num(v.state), due: date(v.due), reviewedAt: date(v.reviewedAt), elapsedMs: num(v.elapsedMs ?? 0) };
  },
  tests(v: unknown): TestRecord {
    if (!isObj(v)) throw new Bad('test');
    const config: Record<string, unknown> = {};
    if (isObj(v.config)) for (const [k, x] of Object.entries(v.config)) if (['string', 'number', 'boolean'].includes(typeof x)) config[str(k, 50)] = typeof x === 'string' ? str(x, 200) : x;
    return {
      id: str(v.id, 64), deckId: str(v.deckId, 64), seed: num(v.seed), config,
      attempts: arr(v.attempts ?? [], a => { if (!isObj(a)) throw new Bad('attempt'); return { startedAt: num(a.startedAt), finishedAt: num(a.finishedAt), answers: [], score: num(a.score) }; }, 1000),
    };
  },
};

export function parseImport(text: string): Bundle {
  if (text.length > IMPORT_MAX_BYTES) throw new Error('That file is over 25 MB.');
  let raw: unknown;
  try {
    raw = JSON.parse(text, (k, v) => {
      if (BANNED.has(k)) throw new Bad('key');
      return v;
    });
  } catch {
    throw new Error("That isn't a Study Kit progress file.");
  }
  if (!isObj(raw) || raw.format !== 'studykit' || typeof raw.schemaVersion !== 'number' || raw.schemaVersion > SCHEMA_VERSION)
    throw new Error("That isn't a Study Kit progress file, or it's from a newer version.");
  try {
    const out = {} as Bundle;
    for (const s of STORES) (out as Record<string, unknown[]>)[s] = arr(raw[s] ?? [], V[s] as (x: unknown) => unknown);
    return out;
  } catch (e) {
    if (e instanceof Bad) throw new Error('That progress file is damaged, so nothing was imported.');
    throw e;
  }
}

// Re-mint IDs that already exist locally, rewriting every reference to them.
export function remapConflicts(b: Bundle, exists: { sources: Set<string>; items: Set<string>; decks: Set<string>; tests: Set<string> }, mint: () => string): Bundle {
  const src = new Map<string, string>(), itm = new Map<string, string>(), dck = new Map<string, string>();
  const re = (id: string, set: Set<string>, map: Map<string, string>) => {
    if (!set.has(id)) return id;
    const n = mint();
    map.set(id, n);
    return n;
  };
  const sources = b.sources.map(s => ({ ...s, id: re(s.id, exists.sources, src) }));
  const items = b.items.map(i => ({ ...i, id: re(i.id, exists.items, itm), sourceId: src.get(i.sourceId) ?? i.sourceId }));
  const decks = b.decks.map(d => ({ ...d, id: re(d.id, exists.decks, dck), sourceIds: d.sourceIds.map(x => src.get(x) ?? x), itemIds: d.itemIds.map(x => itm.get(x) ?? x) }));
  return {
    sources, items, decks,
    srs: b.srs.map(c => ({ ...c, itemId: itm.get(c.itemId) ?? c.itemId })),
    reviewLog: b.reviewLog.map(l => ({ ...l, itemId: itm.get(l.itemId) ?? l.itemId })),
    tests: b.tests.map(t => ({ ...t, id: exists.tests.has(t.id) ? mint() : t.id, deckId: dck.get(t.deckId) ?? t.deckId })),
  };
}

// --- Card exports ---------------------------------------------------------

export function cardFaces(i: Item): [string, string] | null {
  const p = i.payload;
  switch (p.t) {
    case 'flash': return [p.front, p.back];
    case 'cloze': return [p.text, p.answer];
    case 'mcq': return [p.stem, p.answer];
    case 'tf': return [p.statement, p.answer ? 'True' : `False. ${p.original}`];
    case 'explain': return [p.prompt, p.answer];
    case 'selfcheck': return [p.question, 'Check your work against your notes or your teacher.'];
    case 'match': return null;
    case 'sequence': return [p.prompt, p.steps.map((s, k) => `${k + 1}. ${s}`).join(' ')];
  }
}

export function deckDelimited(items: Item[], sep: ',' | '\t'): string {
  const cell = (s: string) => {
    if (sep === '\t') return s.replace(/[\t\r\n]+/g, ' ');
    // Neutralize spreadsheet formulas in CSV; TSV stays raw for card apps.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows = [['front', 'back', 'tags', 'source']];
  for (const i of items) {
    const f = cardFaces(i);
    if (f) rows.push([f[0], f[1], `studykit ${i.type}`, i.sourceRef.text]);
  }
  return rows.map(r => r.map(cell).join(sep)).join('\r\n') + '\r\n';
}

export function dailyIcs(hour: number, minute: number, uid: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Study Kit//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${uid}@studykit.local`, `DTSTAMP:${stamp}`, `DTSTART:${day}T${pad(hour)}${pad(minute)}00`, 'DURATION:PT15M', 'RRULE:FREQ=DAILY',
    'SUMMARY:Study Kit review', 'DESCRIPTION:Open Study Kit and review the cards due today.', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}
