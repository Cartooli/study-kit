import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyIcs, deckDelimited, exportJson, parseImport, remapConflicts, type Bundle } from '../src/io.ts';
import type { Item } from '../src/types.ts';

const item: Item = {
  id: 'i1', sourceId: 's1', type: 'flash', payload: { t: 'flash', front: '=HYPERLINK("x")', back: 'a, "quoted"\nline' }, confidence: 1,
  sourceRef: { blockId: 'b0', sentenceIdx: 0, text: 'src' }, status: 'active', seed: 1, createdAt: 1,
};
const bundle: Bundle = {
  sources: [{ id: 's1', title: 'T', fileName: 'f.txt', mime: 'text/plain', sizeBytes: 1, textHash: '', docType: 'reading', blocks: [{ id: 'b0', kind: 'paragraph', text: 'src', order: 0 }], stats: { words: 1, sentences: 1, minutes: 1 }, createdAt: 1 }],
  items: [item],
  decks: [{ id: 'd1', title: 'D', sourceIds: ['s1'], itemIds: ['i1'], settings: { types: ['flash'], count: 'auto', difficulty: 'recall', seed: 1 }, createdAt: 1, updatedAt: 1 }],
  srs: [{ itemId: 'i1', due: new Date('2026-01-02T00:00:00Z'), stability: 1, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, state: 2 }],
  reviewLog: [{ itemId: 'i1', rating: 3, state: 0, due: new Date('2026-01-01T00:00:00Z'), reviewedAt: new Date('2026-01-01T00:00:00Z'), elapsedMs: 900 }],
  tests: [],
};

test('export → import round-trips, dates restored', () => {
  const b = parseImport(exportJson(bundle));
  assert.deepEqual(JSON.parse(JSON.stringify(b.items)), bundle.items);
  assert.equal(b.decks[0].settings.count, 'auto');
  assert.ok(b.srs[0].due instanceof Date && +b.srs[0].due === +bundle.srs[0].due);
});

test('import rejects prototype pollution, wrong format, damaged records', () => {
  assert.throws(() => parseImport('{"format":"studykit","schemaVersion":1,"__proto__":{"x":1}}'), /isn't a Study Kit/);
  assert.throws(() => parseImport('{"format":"other"}'), /isn't a Study Kit/);
  assert.throws(() => parseImport('not json'), /isn't a Study Kit/);
  const bad = JSON.parse(exportJson(bundle));
  bad.items[0].type = 'script';
  assert.throws(() => parseImport(JSON.stringify(bad)), /damaged/);
  const long = JSON.parse(exportJson(bundle));
  long.items[0].payload.front = 'x'.repeat(30_000);
  assert.throws(() => parseImport(JSON.stringify(long)), /damaged/);
});

test('import drops unknown fields', () => {
  const extra = JSON.parse(exportJson(bundle));
  extra.items[0].evil = '<img onerror=alert(1)>';
  extra.items[0].payload.onclick = 'x';
  const b = parseImport(JSON.stringify(extra));
  assert.ok(!('evil' in b.items[0]) && !('onclick' in b.items[0].payload));
});

test('conflicting IDs are re-minted and references rewritten', () => {
  let n = 0;
  const b = remapConflicts(bundle, { sources: new Set(['s1']), items: new Set(['i1']), decks: new Set(), tests: new Set() }, () => `new${++n}`);
  assert.equal(b.sources[0].id, 'new1');
  assert.equal(b.items[0].id, 'new2');
  assert.equal(b.items[0].sourceId, 'new1');
  assert.deepEqual(b.decks[0].itemIds, ['new2']);
  assert.equal(b.srs[0].itemId, 'new2');
  assert.equal(b.reviewLog[0].itemId, 'new2');
});

test('CSV escapes quotes/newlines and neutralizes formulas; TSV stays raw', () => {
  const csv = deckDelimited([item], ',');
  assert.ok(csv.startsWith(`front,back,tags,source\r\n"'=HYPERLINK(""x"")",`));
  assert.match(csv, /"a, ""quoted""\nline"/);
  const tsv = deckDelimited([item], '\t');
  assert.match(tsv, /\r\n=HYPERLINK\("x"\)\ta, "quoted" line\t/);
});

test('ics: one daily recurring event at the chosen time', () => {
  const ics = dailyIcs(18, 30, 'u1', new Date(2026, 9, 27, 9));
  assert.match(ics, /DTSTART:20261027T183000\r\n/);
  assert.match(ics, /RRULE:FREQ=DAILY/);
});
