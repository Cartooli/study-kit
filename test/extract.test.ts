import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { decodeText, parseDocx, parsePptx, parseText, UserError } from '../src/engine/extract.ts';
import { extractPdf } from '../src/engine/pdf.ts';
import { docx, para, pdf, pptx } from './helpers.ts';

test('markdown: headings, lists, tables, inline marks', () => {
  const b = parseText('# Title\n\nSome **bold** [link](http://x) text.\n\n1. first\n2. second\n\n| a | b |\n|---|---|\n| c | d |');
  assert.deepEqual(b.map(x => [x.kind, x.text]), [['heading', 'Title'], ['paragraph', 'Some bold link text.'], ['listItem', 'first'], ['listItem', 'second'], ['tableRow', 'a — b'], ['tableRow', 'c — d']]);
  assert.equal(b[2].ordered, true);
});

test('text: windows-1252 fallback', () => {
  assert.equal(decodeText(new Uint8Array([0x93, 0x68, 0x69, 0x94])), '“hi”');
});

test('text: 300,000 character cap', () => {
  assert.throws(() => parseText('a'.repeat(300_001)), UserError);
});

test('docx: headings, numbered lists, tables, entities', () => {
  const b = parseDocx(docx(para('Rocks', 'Heading1') + para('Igneous rock forms from cooled magma &amp; lava.') + para('Step one', 'ListNumber', true) +
    '<w:tbl><w:tr><w:tc>' + para('Term') + '</w:tc><w:tc>' + para('Meaning') + '</w:tc></w:tr></w:tbl>'));
  assert.deepEqual(b.map(x => [x.kind, x.text]), [['heading', 'Rocks'], ['paragraph', 'Igneous rock forms from cooled magma & lava.'], ['listItem', 'Step one'], ['tableRow', 'Term — Meaning']]);
});

test('docx: rejects DOCTYPE (XML entity attacks)', () => {
  const evil = zipSync({ 'word/document.xml': strToU8('<!DOCTYPE x [<!ENTITY a "b">]><w:document/>') });
  assert.throws(() => parseDocx(evil), UserError);
});

test('docx: rejects zip bombs by compression ratio', () => {
  const bomb = zipSync({ 'word/document.xml': new Uint8Array(5_000_000) }, { level: 9 });
  assert.throws(() => parseDocx(bomb), /damaged or unusually packed/);
});

test('docx: rejects too many entries and garbage', () => {
  const many = zipSync(Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f${i}.txt`, strToU8('x')])));
  assert.throws(() => parseDocx(many), UserError);
  assert.throws(() => parseDocx(strToU8('not a zip')), UserError);
});

test('pptx: slide titles become headings, in slide order', () => {
  const b = parsePptx(pptx([{ title: 'Volcanoes', body: ['Magma rises.'] }, { title: 'Earthquakes', body: ['Plates slip.'] }]));
  assert.deepEqual(b.map(x => [x.kind, x.text, x.page]), [['heading', 'Volcanoes', 1], ['listItem', 'Magma rises.', 1], ['heading', 'Earthquakes', 2], ['listItem', 'Plates slip.', 2]]);
});

test('pdf: text layer, repeated footers and page numbers removed, de-hyphenation', async () => {
  const page = (n: number) => ['Sample Science Reader', `Part ${'ABC'[n - 1]}: the water cycle moves water between land and sky. Evapo-`, 'ration turns liquid water into vapor.', String(n)];
  const r = await extractPdf(pdf([page(1), page(2), page(3)]));
  assert.equal(r.pages, 3);
  const text = r.blocks.map(b => b.text).join(' | ');
  assert.match(text, /Evaporation turns liquid water/);
  assert.doesNotMatch(text, /Sample Science Reader/);
  assert.doesNotMatch(text, /\| 2/);
});

test('pdf: garbage is a friendly error, not a crash', async () => {
  await assert.rejects(extractPdf(strToU8('%PDF-1.4 garbage')), UserError);
});
