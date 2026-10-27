import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Grade } from 'ts-fsrs';
import { exportJson, parseImport, remapConflicts, STORES, type Bundle, type ReviewLog, type SrsCard, type StoreName, type TestRecord } from './io.ts';
import type { Deck, Item, Source } from './types.ts';

// --- Storage: IndexedDB "studykit", or in-memory when the browser won't allow it (§9.4). ---

const KEYS: Record<StoreName, string | null> = { sources: 'id', items: 'id', decks: 'id', srs: 'itemId', reviewLog: null, tests: 'id', settings: 'key' };
let db: IDBPDatabase | null = null;
const mem = new Map<StoreName, Map<IDBValidKey, unknown>>();
let memLogId = 0;
export let persistent = false;

export async function initDb() {
  try {
    db = await openDB('studykit', 1, {
      upgrade(d, oldVersion) {
        // Migrations are keyed by version number; v1 creates everything.
        if (oldVersion < 1) {
          d.createObjectStore('sources', { keyPath: 'id' });
          d.createObjectStore('items', { keyPath: 'id' }).createIndex('sourceId', 'sourceId');
          d.createObjectStore('decks', { keyPath: 'id' });
          d.createObjectStore('srs', { keyPath: 'itemId' }).createIndex('due', 'due');
          d.createObjectStore('reviewLog', { autoIncrement: true, keyPath: 'id' }).createIndex('itemId', 'itemId');
          d.createObjectStore('tests', { keyPath: 'id' });
          d.createObjectStore('settings', { keyPath: 'key' });
        }
      },
    });
    persistent = true;
  } catch {
    db = null;
    persistent = false;
  }
}

const m = (s: StoreName) => mem.get(s) ?? (mem.set(s, new Map()), mem.get(s)!);

export async function get<T>(s: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return db ? db.get(s, key) : (m(s).get(key) as T | undefined);
}
export async function all<T>(s: StoreName): Promise<T[]> {
  return db ? db.getAll(s) : ([...m(s).values()] as T[]);
}
export async function putMany(s: StoreName, values: object[]) {
  if (db) {
    const tx = db.transaction(s, 'readwrite');
    await Promise.all([...values.map(v => tx.store.put(v)), tx.done]);
  } else {
    const k = KEYS[s];
    for (const v of values) {
      const rec = v as Record<string, IDBValidKey>;
      if (!k) rec.id ??= ++memLogId;
      m(s).set(rec[k ?? 'id'], v);
    }
  }
}
export const put = (s: StoreName, v: object) => putMany(s, [v]);
export async function delMany(s: StoreName, keys: IDBValidKey[]) {
  if (db) {
    const tx = db.transaction(s, 'readwrite');
    await Promise.all([...keys.map(k => tx.store.delete(k)), tx.done]);
  } else for (const k of keys) m(s).delete(k);
}
export async function itemsOf(sourceIds: string[]): Promise<Item[]> {
  if (!db) return all<Item>('items').then(xs => xs.filter(i => sourceIds.includes(i.sourceId)));
  const lists = await Promise.all(sourceIds.map(id => db!.getAllFromIndex('items', 'sourceId', id)));
  return lists.flat();
}

// --- Settings ---------------------------------------------------------------

export type Settings = { theme: 'system' | 'light' | 'dark'; textSize: number; spacing: boolean; newPerDay: number; hints: boolean };
export const DEFAULT_SETTINGS: Settings = { theme: 'system', textSize: 100, spacing: false, newPerDay: 20, hints: true };
export async function loadSettings(): Promise<Settings> {
  const rows = await all<{ key: string; value: unknown }>('settings');
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map(r => [r.key, r.value])) };
}
export const saveSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => put('settings', { key, value });

export function applySettings(s: Settings) {
  const root = document.documentElement;
  if (s.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  root.style.setProperty('--text-scale', String(s.textSize / 100));
  root.classList.toggle('spaced', s.spacing);
}

// --- IDs ----------------------------------------------------------------------

export function uid(): string {
  // getRandomValues (not randomUUID) also works outside secure contexts.
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(text: string): Promise<string> {
  if (!crypto.subtle) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Decks ----------------------------------------------------------------------

export async function saveNewDeck(source: Source, items: Item[], deck: Deck) {
  await put('sources', source);
  await putMany('items', items);
  await put('decks', deck);
  // Ask the browser not to evict storage once there is something worth keeping.
  if (persistent && navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

export async function deckData(deckId: string) {
  const deck = await get<Deck>('decks', deckId);
  if (!deck) return null;
  const sources = (await Promise.all(deck.sourceIds.map(id => get<Source>('sources', id)))).filter((s): s is Source => !!s);
  const byId = new Map((await itemsOf(deck.sourceIds)).map(i => [i.id, i]));
  const items = deck.itemIds.map(id => byId.get(id)).filter((i): i is Item => !!i && i.status !== 'deleted');
  return { deck, sources, items };
}

export async function deleteDeck(deck: Deck) {
  const items = await itemsOf(deck.sourceIds);
  const ids = items.map(i => i.id);
  await delMany('items', ids);
  await delMany('srs', ids);
  const logs = (await all<ReviewLog>('reviewLog')).filter(l => ids.includes(l.itemId));
  await delMany('reviewLog', logs.map(l => l.id!));
  await delMany('tests', (await all<TestRecord>('tests')).filter(t => t.deckId === deck.id).map(t => t.id));
  await delMany('sources', deck.sourceIds);
  await delMany('decks', [deck.id]);
}

export async function saveItem(item: Item) {
  await put('items', item);
}

// --- Spaced repetition (§9) ---------------------------------------------------

const scheduler = fsrs(generatorParameters({ enable_fuzz: true, request_retention: 0.9 }));
export const REVIEWABLE = new Set(['flash', 'cloze', 'explain', 'selfcheck']); // MCQ/TF/matching review as these
export { Rating, State, type Grade };

export type QueueEntry = { item: Item; card: SrsCard; isNew: boolean };

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export async function buildQueue(settings: Settings, deckId?: string, now = new Date()): Promise<QueueEntry[]> {
  const decks = deckId ? [await get<Deck>('decks', deckId)].filter((d): d is Deck => !!d) : await all<Deck>('decks');
  const wanted = new Set(decks.flatMap(d => d.itemIds));
  const items = (await itemsOf(decks.flatMap(d => d.sourceIds))).filter(i => wanted.has(i.id) && REVIEWABLE.has(i.type) && (i.status === 'active' || i.status === 'edited'));
  const cards = new Map((await all<SrsCard>('srs')).map(c => [c.itemId, c]));
  const today = startOfDay(now);
  const newToday = (await all<ReviewLog>('reviewLog')).filter(l => new Date(l.reviewedAt) >= today && l.state === State.New).length;
  const due: QueueEntry[] = [], fresh: QueueEntry[] = [];
  for (const item of items) {
    const card = cards.get(item.id);
    if (card?.suspended) continue;
    if (!card || card.state === State.New) fresh.push({ item, card: card ?? { ...createEmptyCard(now), itemId: item.id }, isNew: true });
    else if (new Date(card.due) <= now) due.push({ item, card, isNew: false });
  }
  due.sort((a, b) => +new Date(a.card.due) - +new Date(b.card.due));
  return [...due, ...fresh.slice(0, Math.max(0, settings.newPerDay - newToday))];
}

export function previews(card: SrsCard, now = new Date()): Record<Grade, Date> {
  const p = scheduler.repeat(card, now);
  return { [Rating.Again]: p[Rating.Again].card.due, [Rating.Hard]: p[Rating.Hard].card.due, [Rating.Good]: p[Rating.Good].card.due, [Rating.Easy]: p[Rating.Easy].card.due } as Record<Grade, Date>;
}

export async function rate(entry: QueueEntry, grade: Grade, elapsedMs: number, now = new Date()) {
  const { card, log } = scheduler.next(entry.card, now, grade);
  const next: SrsCard = { ...card, itemId: entry.item.id, suspended: entry.card.suspended };
  const logRow: ReviewLog = { itemId: entry.item.id, rating: grade, state: log.state, due: log.due, reviewedAt: now, elapsedMs };
  await put('srs', next);
  await put('reviewLog', logRow);
  return { next, logRow };
}

export async function undoRate(prev: SrsCard, isNew: boolean, itemId: string) {
  if (isNew) await delMany('srs', [itemId]);
  else await put('srs', prev);
  const logs = (await all<ReviewLog>('reviewLog')).filter(l => l.itemId === itemId);
  const last = logs.sort((a, b) => +new Date(b.reviewedAt) - +new Date(a.reviewedAt))[0];
  if (last?.id !== undefined) await delMany('reviewLog', [last.id]);
}

export async function suspend(entry: QueueEntry) {
  await put('srs', { ...entry.card, suspended: true });
}

export function humanInterval(due: Date, now = new Date()): string {
  const mins = Math.round((+due - +now) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr`;
  const days = Math.round(hrs / 24);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} mo` : `${Math.round(days / 365)} yr`;
}

export async function dueTomorrow(now = new Date()): Promise<number> {
  const end = new Date(startOfDay(now).getTime() + 2 * 86400000);
  return (await all<SrsCard>('srs')).filter(c => !c.suspended && c.state !== State.New && new Date(c.due) < end && new Date(c.due) > now).length;
}

// --- Export / import / wipe -------------------------------------------------

export async function bundle(deckId?: string): Promise<Bundle> {
  const b = Object.fromEntries(await Promise.all(STORES.map(async s => [s, await all(s)]))) as Bundle;
  b.sources = b.sources.map(({ restate: _r, ...s }) => s);
  if (!deckId) return b;
  const deck = b.decks.find(d => d.id === deckId);
  const ids = new Set(deck?.itemIds ?? []);
  return {
    decks: deck ? [deck] : [],
    sources: b.sources.filter(s => deck?.sourceIds.includes(s.id)),
    items: b.items.filter(i => ids.has(i.id)),
    srs: b.srs.filter(c => ids.has(c.itemId)),
    reviewLog: b.reviewLog.filter(l => ids.has(l.itemId)).map(({ id: _id, ...l }) => l),
    tests: b.tests.filter(t => t.deckId === deckId),
  };
}

export const exportAll = async (deckId?: string) => exportJson(await bundle(deckId));

export async function importText(text: string) {
  const parsed = parseImport(text);
  const ids = async (s: StoreName, k: string) => new Set((await all<Record<string, string>>(s)).map(r => r[k]));
  const b = remapConflicts(parsed, { sources: await ids('sources', 'id'), items: await ids('items', 'id'), decks: await ids('decks', 'id'), tests: await ids('tests', 'id') }, uid);
  await putMany('sources', b.sources); // restatements are rebuilt on first view
  await putMany('items', b.items);
  await putMany('decks', b.decks);
  await putMany('srs', b.srs);
  await putMany('reviewLog', b.reviewLog);
  await putMany('tests', b.tests);
  return b.decks.length;
}

// Caches hold only the app's own static files (never user data); old ones are dropped when a new version activates.
export async function wipeEverything() {
  db?.close();
  db = null;
  mem.clear();
  await deleteDB('studykit');
  for (const s of [localStorage, sessionStorage])
    for (let i = s.length - 1; i >= 0; i--) {
      const k = s.key(i);
      if (k?.startsWith('studykit:')) s.removeItem(k);
    }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  const e = await navigator.storage?.estimate?.();
  return e?.quota ? { usage: e.usage ?? 0, quota: e.quota } : null;
}
