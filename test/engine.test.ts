import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseText } from '../src/engine/extract.ts';
import { generate, simplifySentence, THRESHOLD, whyQuestion } from '../src/engine/generate.ts';
import { answerMatches, fkGrade, splitSentences } from '../src/engine/text.ts';
import { ITEM_TYPES, type GenSettings, type Item } from '../src/types.ts';

const ALL: GenSettings = { types: ITEM_TYPES, count: 'auto', difficulty: 'recall' };
const run = (f: string, settings = ALL, seed = 1) => {
  const blocks = parseText(readFileSync(new URL(`fixtures/${f}`, import.meta.url), 'utf8'));
  return { blocks, ...generate(blocks, settings, seed, 'src', 'i') };
};
const shown = (items: Item[]) => items.filter(i => i.status === 'active');
const p = (i: Item) => JSON.stringify(i.payload);

test('worked example (§8.9): definitions, cloze, explain-it-back', () => {
  const r = run('photosynthesis.txt');
  assert.equal(r.docType, 'reading');
  assert.ok(r.notices.includes('Short text — fewer items.'));
  const s = shown(r.items);
  assert.ok(s.some(i => i.payload.t === 'flash' && /photosynthesis/i.test(i.payload.front) && /light energy into chemical energy/.test(i.payload.back)));
  assert.ok(s.some(i => i.payload.t === 'flash' && i.payload.front === 'stomata' && /small openings/i.test(i.payload.back)));
  assert.ok(s.some(i => i.payload.t === 'cloze' && i.payload.answer === 'chlorophyll' && i.payload.hint === 'c, 11 letters' && !!i.payload.context));
  assert.ok(s.some(i => i.payload.t === 'explain' && i.payload.prompt === 'Why do forests help keep the air breathable?' && /release oxygen/.test(i.payload.answer)));
  assert.ok(!s.some(i => i.type === 'mcq' || i.type === 'tf'), 'short texts only get definition, cloze and explain items');
});

test('document typing', () => {
  for (const [f, t] of [['reading.md', 'reading'], ['lesson.md', 'lesson'], ['homework.txt', 'homework'], ['essay.txt', 'essay'], ['notes.txt', 'notes'], ['math.txt', 'math']] as const)
    assert.equal(run(f).docType, t, f);
});

test('every enabled type is produced or skipped with a reason (acceptance 4)', () => {
  for (const f of ['reading.md', 'lesson.md', 'homework.txt', 'essay.txt', 'notes.txt', 'math.txt']) {
    const r = run(f);
    for (const t of ITEM_TYPES) assert.ok(shown(r.items).some(i => i.type === t) || r.skipped[t], `${f}: ${t}`);
  }
});

test('every item cites a real source sentence (acceptance 5)', () => {
  for (const f of ['reading.md', 'lesson.md', 'homework.txt', 'essay.txt', 'notes.txt']) {
    const r = run(f);
    for (const i of r.items) {
      const b = r.blocks.find(x => x.id === i.sourceRef.blockId);
      assert.ok(b && b.text.includes(i.sourceRef.text), `${f}: ${p(i)}`);
    }
  }
});

test('confidence threshold splits shown and hidden items', () => {
  const r = run('reading.md');
  for (const i of r.items) assert.equal(i.status === 'active', i.confidence >= THRESHOLD);
});

test('MCQ never pads: 3+ distinct distractors, none equal to or containing the answer', () => {
  for (const f of ['reading.md', 'lesson.md', 'essay.txt']) {
    for (const i of run(f).items) {
      if (i.payload.t !== 'mcq') continue;
      const a = i.payload.answer.toLowerCase();
      assert.ok(new Set(i.payload.pool).size >= 3, p(i));
      for (const d of i.payload.pool) assert.ok(!d.toLowerCase().includes(a) && !a.includes(d.toLowerCase()), p(i));
    }
  }
});

test('true/false: roughly balanced, false items keep the original as explanation, no inserted "not"', () => {
  const tf = shown(run('reading.md').items).filter(i => i.payload.t === 'tf');
  const f = tf.filter(i => i.payload.t === 'tf' && !i.payload.answer);
  assert.ok(tf.length >= 6 && Math.abs(f.length * 2 - tf.length) <= 2, `${f.length}/${tf.length}`);
  for (const i of f) if (i.payload.t === 'tf') {
    assert.notEqual(i.payload.statement, i.payload.original);
    assert.ok(!/\bnot\b/.test(i.payload.statement) || /\bnot\b/.test(i.payload.original));
  }
});

test('homework: questions become self-check cards; no invented answers', () => {
  const r = run('homework.txt');
  const s = shown(r.items);
  assert.ok(s.length >= 6 && s.every(i => i.type === 'selfcheck'));
});

test('lesson plan: Materials and Procedure skipped; objectives become prompts', () => {
  const r = run('lesson.md');
  assert.ok(!r.items.some(i => /egg|knife|pencil/i.test(i.sourceRef.text) && i.type !== 'explain'));
  assert.ok(shown(r.items).some(i => i.payload.t === 'explain' && i.payload.prompt.startsWith('Describe the three main layers')));
  assert.ok(shown(r.items).some(i => i.type === 'match'));
});

test('essay: no true/false, at most 5 MCQs, defend-your-claim prompts', () => {
  const r = run('essay.txt');
  assert.ok(r.skipped.tf);
  assert.ok(shown(r.items).filter(i => i.type === 'mcq').length <= 5);
  assert.ok(shown(r.items).some(i => i.payload.t === 'explain' && i.payload.prompt.startsWith('Defend this claim')));
});

test('math-heavy: vocabulary only, with banner', () => {
  const r = run('math.txt');
  assert.ok(r.notices[0].startsWith('Study Kit works best on reading material'));
  assert.ok(r.items.every(i => i.type === 'flash'));
});

test('too little text is refused', () => {
  assert.throws(() => generate(parseText('Too short to study.'), ALL, 1, 's', 'i'), /Add a bit more text/);
});

test('deterministic per seed; a new seed changes the set', () => {
  const a = run('reading.md', ALL, 1), b = run('reading.md', ALL, 1), c = run('reading.md', ALL, 2);
  assert.deepEqual(a.items, b.items);
  assert.notDeepEqual(a.items.map(p), c.items.map(p));
});

test('count setting caps shown items and follows difficulty order', () => {
  const r = run('reading.md', { ...ALL, count: 10, difficulty: 'recognition' });
  const s = shown(r.items);
  assert.equal(s.length, 10);
  assert.ok(s.filter(i => ['mcq', 'tf', 'match'].includes(i.type)).length >= 5);
});

test('restatements: key points in order, glossary A–Z, simplified text', () => {
  const { restate } = run('reading.md');
  assert.ok(restate.keyPoints.length >= 5 && restate.keyPoints.length <= 10);
  const terms = restate.glossary.map(g => g.term.toLowerCase());
  assert.deepEqual(terms, [...terms].sort());
  assert.equal(restate.outline[0].title, 'The Water Cycle');
  assert.equal(simplifySentence('We utilize approximately ten tools (see below); they help.'), 'We use about ten tools. They help.');
});

test('text helpers', () => {
  assert.deepEqual(splitSentences('Dr. Lee met Mr. Ono in the U.S. today. They talked.'), ['Dr. Lee met Mr. Ono in the U.S. today.', 'They talked.']);
  assert.ok(answerMatches('Chlorophyl', 'chlorophyll'));
  assert.ok(answerMatches('the stomata', 'stomata'));
  assert.ok(!answerMatches('stoma', 'chlorophyll'));
  assert.ok(answerMatches('plants', 'plant'));
  assert.ok(fkGrade('The cat sat on the mat.') < 3);
  assert.equal(whyQuestion('the inner core stays solid'), 'Why does the inner core stay solid?');
  assert.equal(whyQuestion('Rome was rebuilt'), 'Why was Rome rebuilt?');
});
