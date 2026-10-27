import nlp from 'compromise';
import type { Block, DocType, GenSettings, Item, ItemType, Payload, Restatements, Stats } from '../types.ts';
import { UserError } from './extract.ts';
import { capitalize, contentStems, editDistance, escapeRe, fkGrade, jaccard, rng, splitSentences, stem, trimWords, words } from './text.ts';
import { ANTONYMS, CAUSAL, COMMON, ENUMERATION, FIRST_SECOND, NEGATION, PLAIN_SWAPS, PRONOUN_LEAD, STOPWORDS } from './words.ts';

export const THRESHOLD = 0.6; // [tune in M0]

type Tok = { text: string; norm: string; tags: string[]; post: string };
type Cls = 'person' | 'place' | 'org' | 'date' | 'concept' | 'conceptPl';
type Chunk = { key: string; text: string; cls: Cls };
type Sent = { i: number; text: string; blockId: string; idx: number; section: number; para: number; ordered?: boolean; kind: Block['kind']; toks: Tok[]; chunks: Chunk[]; stems: string[] };
type Term = { key: string; text: string; cls: Cls; tf: number; paras: Set<number>; sents: Set<number>; sections: Set<number>; heading: boolean; def: boolean; score: number };
type Def = { term: string; key: string; def: string; sent: Sent; conf: number };
type Section = { title: string; level: number; blockId?: string };

export type Analysis = { sents: Sent[]; sections: Section[]; terms: Map<string, Term>; defs: Def[]; docType: DocType; stats: Stats; blocks: Block[] };

const has = (t: Tok, tag: string) => t.tags.includes(tag);
const clean = (s: string) => s.replace(/^[^\w$]+|[^\w%]+$/g, '');
const keyOf = (s: string) => words(s).map(stem).join(' ');
const YEAR = /\b(1[0-9]{3}|20[0-9]{2})\b/;
const SKIP_SECTIONS = /\b(materials?|procedures?|supplies|preparation|prep|set-?up)\b/i;
const TEACHER_SECTIONS = /\b(objectives?|goals?|learning targets?|standards?|assessment|closure|differentiation)\b/i;
const VOCAB_SECTIONS = /vocab|key terms|glossary|definitions|word bank/i;

function tag(text: string): Tok[] {
  const json = nlp(text).json() as { terms: { text: string; normal?: string; tags: string[]; post: string }[] }[];
  return json.flatMap(s => s.terms.map(t => ({ text: t.text, norm: t.normal ?? t.text.toLowerCase(), tags: t.tags, post: t.post ?? '' })));
}

function classify(toks: Tok[]): Cls {
  if (toks.some(t => has(t, 'Person'))) return 'person';
  if (toks.some(t => has(t, 'Place'))) return 'place';
  if (toks.some(t => has(t, 'Organization'))) return 'org';
  return has(toks[toks.length - 1], 'Plural') ? 'conceptPl' : 'concept';
}

function chunk(toks: Tok[]): Chunk[] {
  const out: Chunk[] = [];
  let cur: Tok[] = [];
  const emit = () => {
    while (cur.length && !has(cur[cur.length - 1], 'Noun')) cur.pop();
    while (cur.length > 1 && (COMMON.has(cur[0].norm) || has(cur[0], 'Value'))) cur.shift();
    if (cur.length >= 1 && cur.length <= 4) {
      const text = cur.map(t => clean(t.text)).join(' ');
      const key = keyOf(text);
      const single = cur.length === 1;
      if (key.length >= 3 && /[a-z]/i.test(text) && !(single && (COMMON.has(cur[0].norm) || STOPWORDS.has(cur[0].norm))) && !/^\d/.test(text))
        out.push({ key, text, cls: classify(cur) });
    }
    cur = [];
  };
  for (const t of toks) {
    const ok = (has(t, 'Noun') || has(t, 'Adjective') || has(t, 'Acronym')) && !has(t, 'Pronoun') && !has(t, 'Determiner') && !STOPWORDS.has(t.norm) && /[a-z]/i.test(t.text);
    if (ok) cur.push(t);
    if (!ok || /[,;:.!?()"—]/.test(t.post) || /[,;:.!?()"]$/.test(t.text)) emit();
  }
  emit();
  return out;
}

// --- Definitions (§8.2) ----------------------------------------------------

const PRON_START = /^(it|this|that|these|those|they|he|she|there|we|you|i|which|what|who|one|some|many|most|all|each|another)\b/i;
const looksLikeTerm = (x: string) => {
  const w = x.trim().split(/\s+/);
  return w.length >= 1 && w.length <= 4 && !PRON_START.test(x) && /^[\w'(][\w '’()-]*$/.test(x) && !(w.length === 1 && (COMMON.has(w[0].toLowerCase()) || STOPWORDS.has(w[0].toLowerCase())));
};

function npBefore(s: Sent, word: string): string | null {
  const i = s.toks.findIndex(t => t.norm === word);
  if (i < 1) return null;
  const np: Tok[] = [];
  for (let j = i - 1; j >= 0 && np.length < 6; j--) {
    const t = s.toks[j];
    if (j < i - 1 && /[,;:]/.test(t.post)) break;
    if (/^(a|an|the)$/.test(t.norm)) { np.unshift(t); break; }
    if ((has(t, 'Noun') || has(t, 'Adjective') || has(t, 'Value')) && !has(t, 'Pronoun') && !has(t, 'Preposition')) np.unshift(t);
    else break;
  }
  const head = np[np.length - 1];
  if (!head || !has(head, 'Noun') || COMMON.has(head.norm) || COMMON.has(stem(head.norm))) return null;
  return np.map(t => clean(t.text)).join(' ');
}

function findDefs(sents: Sent[], sections: Section[], docType: DocType, blocks: Block[]): Def[] {
  const defs: Def[] = [];
  const add = (term: string, def: string, sent: Sent, conf = 1) => {
    term = clean(term.replace(/^(the|a|an)\s+/i, ''));
    def = def.trim().replace(/[.;:,]+$/, '');
    if (!looksLikeTerm(term) || def.split(/\s+/).length < 2 || keyOf(def).includes(keyOf(term))) return;
    if (def.split(/\s+/).length > 30) conf *= 0.8;
    if (def.split(/\s+/).length <= 2) conf *= 0.85;
    defs.push({ term, key: keyOf(term), def: trimWords(def, 30), sent, conf });
  };
  for (const s of sents) {
    const t = s.text.replace(/\.$/, '');
    let m;
    const glossaryCtx = VOCAB_SECTIONS.test(sections[s.section].title) || docType === 'notes';
    if (s.idx === 0 && glossaryCtx && (m = t.match(/^([^:–—]{2,50}?)\s*(?::|–|—| - )\s*(.{3,})$/))) { add(m[1], m[2], s); continue; }
    if ((m = t.match(/^(?:the |an? )?([\w'’ ()-]{2,40}?) (?:is|are) (?:defined as |known as )?(an? |the |one of the )(.+)$/i)) && !/^(it|this|that|there)\b/i.test(m[1])) {
      add(m[1], m[2] + m[3], s);
      continue;
    }
    if ((m = t.match(/^(?:the |an? )?([\w'’ ()-]{2,40}?) (?:refers to|means|is defined as|are defined as) (.+)$/i))) { add(m[1], m[2], s); continue; }
    if ((m = t.match(/^(.{3,80}?),? (?:is|are) (?:called|known as|termed) (?:an? |the )?([\w'’ -]{2,40})$/i)) && !PRON_START.test(m[1])) { add(m[2], m[1], s, 0.9); continue; }
    if ((m = t.match(/\bcalled ((?:an? |the )?[a-z][\w-]*(?: [a-z][\w-]*){0,2})(?=[,.;]|$)/i))) {
      const np = npBefore(s, 'called');
      if (np) { add(m[1], np, s, 0.9); continue; }
    }
    if ((m = t.match(/^([A-Z][\w.'’-]*(?: [A-Z][\w.'’-]*){0,3}), (an? |the )([^,]{3,80}),/))) { add(m[1], m[2] + m[3], s, 0.9); continue; }
    if ((m = t.match(/((?:[\w-]+ ){0,5}[\w-]+) \(([A-Z][A-Za-z0-9-]{1,9})\)/))) {
      const words6 = m[1].split(' ');
      // Acronym: take as many trailing words as the acronym has letters.
      const n = m[2].replace(/[^A-Z]/g, '').length;
      const exp = words6.slice(-Math.max(1, n)).join(' ');
      if (exp.split(' ').every(w => /^[a-z]/i.test(w))) add(m[2], exp, s, 0.85);
    }
  }
  // Glossary list items with "X: Y" outside vocab sections are common in notes/lesson plans too.
  for (const b of blocks) if (b.kind === 'listItem' && docType === 'lesson') {
    const m = b.text.match(/^([^:–—]{2,40}?)\s*(?::|–|—| - )\s*(.{3,})$/);
    const s = sents.find(x => x.blockId === b.id);
    if (m && s && !defs.some(d => d.sent === s)) add(m[1], m[2], s, 0.9);
  }
  const seen = new Set<string>();
  return defs.sort((a, b) => b.conf - a.conf).filter(d => (seen.has(d.key) ? false : (seen.add(d.key), true)));
}

// --- Analysis -------------------------------------------------------------

export function detectType(blocks: Block[], sents: Sent[]): DocType {
  const allWords = blocks.flatMap(b => b.text.split(/\s+/));
  const symbolic = allWords.filter(w => /^[\d.,%+\-−×÷=<>^/*()√π]+$/.test(w) || /[=^√∑∫]/.test(w)).length;
  if (allWords.length && symbolic / allWords.length > 0.25) return 'math';
  const body = blocks.filter(b => b.kind !== 'heading');
  const questions = body.filter(b => /\?$/.test(b.text) || /_{3,}/.test(b.text)).length;
  if (body.length && questions / body.length >= 0.3) return 'homework';
  const lessonHeads = blocks.filter(b => b.kind === 'heading' && /objective|standard|material|procedure|vocabulary|assessment|warm-?up|lesson|closure|activity/i.test(b.text)).length;
  if (lessonHeads >= 2) return 'lesson';
  const lw = allWords.map(w => w.toLowerCase().replace(/\W/g, ''));
  const firstPerson = lw.filter(w => ['i', 'my', 'me', 'we', 'our'].includes(w)).length;
  if (lw.length && firstPerson / lw.length > 0.012) return 'essay';
  const fragments = body.filter(b => b.kind === 'listItem' || /^[^:]{2,40}:/.test(b.text) || b.text.split(/\s+/).length < 6).length;
  if (body.length >= 4 && fragments / body.length >= 0.5) return 'notes';
  void sents;
  return 'reading';
}

export function analyze(blocks: Block[]): Analysis {
  const sections: Section[] = [{ title: '', level: 0 }];
  const sents: Sent[] = [];
  let sec = 0, para = 0;
  for (const b of blocks) {
    if (b.kind === 'heading') {
      sections.push({ title: b.text, level: b.level ?? 1, blockId: b.id });
      sec = sections.length - 1;
      continue;
    }
    para++;
    splitSentences(b.text).forEach((text, idx) => {
      const toks = tag(text);
      sents.push({ i: sents.length, text, blockId: b.id, idx, section: sec, para, ordered: b.ordered, kind: b.kind, toks, chunks: chunk(toks), stems: contentStems(text) });
    });
  }
  const docType = detectType(blocks, sents);
  const nWords = blocks.reduce((n, b) => n + b.text.split(/\s+/).length, 0);
  const stats: Stats = { words: nWords, sentences: sents.length, minutes: Math.max(1, Math.round(nWords / 200)) };
  const defs = findDefs(sents, sections, docType, blocks);

  // Candidate terms + years.
  const terms = new Map<string, Term>();
  const forms = new Map<string, Map<string, number>>();
  const touch = (key: string, text: string, cls: Cls, s: Sent) => {
    let t = terms.get(key);
    if (!t) terms.set(key, (t = { key, text, cls, tf: 0, paras: new Set(), sents: new Set(), sections: new Set(), heading: false, def: false, score: 0 }));
    t.tf++;
    t.paras.add(s.para);
    t.sents.add(s.i);
    t.sections.add(s.section);
    const f = forms.get(key) ?? new Map<string, number>();
    f.set(text, (f.get(text) ?? 0) + 1);
    forms.set(key, f);
  };
  for (const s of sents) {
    for (const c of s.chunks) touch(c.key, c.text, c.cls, s);
    const y = s.text.match(new RegExp(YEAR.source, 'g'));
    for (const yr of y ?? []) { touch(yr, yr, 'date', s); s.chunks.push({ key: yr, text: yr, cls: 'date' }); }
  }
  for (const d of defs) {
    if (!terms.has(d.key)) {
      // Definition terms the chunker missed (acronyms, mis-tagged words) still count.
      const cls: Cls = /s$/.test(d.term) && !/ss$/.test(d.term) ? 'conceptPl' : 'concept';
      for (const s of sents) if (new RegExp(`\\b${escapeRe(d.term)}\\b`, 'i').test(s.text)) { touch(d.key, d.term, cls, s); if (!s.chunks.some(c => c.key === d.key)) s.chunks.push({ key: d.key, text: d.term, cls }); }
    }
    const t = terms.get(d.key);
    if (t) t.def = true;
  }
  for (const [key, f] of forms) {
    const t = terms.get(key)!;
    // Prefer the most common surface form; lowercase unless always capitalized.
    t.text = [...f.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  const headingStems = sections.map(s => keyOf(s.title)).join(' | ');
  for (const t of terms.values()) t.heading = t.cls !== 'date' && headingStems.includes(t.key);

  // TextRank over term co-occurrence (window = sentence).
  const keys = [...terms.keys()];
  const idx = new Map(keys.map((k, i) => [k, i]));
  const adj: Map<number, number>[] = keys.map(() => new Map());
  for (const s of sents) {
    const ids = [...new Set(s.chunks.map(c => idx.get(c.key)!).filter(i => i !== undefined))];
    for (const a of ids) for (const b of ids) if (a !== b) adj[a].set(b, (adj[a].get(b) ?? 0) + 1);
  }
  let pr = keys.map(() => 1);
  for (let it = 0; it < 30; it++) {
    const next = keys.map(() => 0.15);
    adj.forEach((nb, a) => {
      const total = [...nb.values()].reduce((x, y) => x + y, 0);
      if (total) nb.forEach((w, b) => (next[b] += (0.85 * pr[a] * w) / total));
    });
    pr = next;
  }
  const maxPr = Math.max(...pr, 1e-9);
  const maxTf = Math.max(...[...terms.values()].map(t => t.tf), 1);
  const paraCount = Math.max(1, para);
  for (const t of terms.values()) {
    const tr = pr[idx.get(t.key)!] / maxPr;
    t.score = (t.tf / maxTf) * (t.paras.size / paraCount) * (1 + (t.def ? 1 : 0)) * (1 + (t.heading ? 0.5 : 0)) * (0.2 + tr);
  }
  return { sents, sections, terms, defs, docType, stats, blocks };
}

// --- Item generation ------------------------------------------------------

const ESSAY_MCQ_CAP = 5;
const CAPS: Record<ItemType, number> = { flash: 40, cloze: 30, mcq: 20, tf: 20, match: 3, sequence: 3, explain: 10, selfcheck: 60 };
const ORDER: Record<GenSettings['difficulty'], ItemType[]> = {
  recall: ['flash', 'cloze', 'explain', 'mcq', 'tf', 'match', 'sequence', 'selfcheck'],
  recognition: ['mcq', 'tf', 'match', 'flash', 'cloze', 'sequence', 'explain', 'selfcheck'],
};

type Cand = { type: ItemType; payload: Payload; conf: number; sent: Sent; context?: string };

export type GenResult = { docType: DocType; stats: Stats; items: Item[]; notices: string[]; skipped: Partial<Record<ItemType, string>>; restate: Restatements };

export function generate(blocks: Block[], settings: GenSettings, seed: number, sourceId: string, idPrefix: string): GenResult {
  const A = analyze(blocks);
  const { sents, sections, terms, defs, docType, stats } = A;
  if (stats.words < 25) throw new UserError('Add a bit more text to make study cards.');
  const r = rng(seed);
  const notices: string[] = [];
  const skipped: Partial<Record<ItemType, string>> = {};
  let allowed = new Set(settings.types);
  if (docType === 'math') {
    notices.push('Study Kit works best on reading material. We made vocabulary cards only.');
    allowed = new Set(['flash'].filter(t => allowed.has(t as ItemType)) as ItemType[]);
  } else if (docType === 'homework') {
    // The worksheet's own questions become self-check cards; never invent answers to them.
    for (const t of settings.types) if (!['flash', 'selfcheck'].includes(t)) skipped[t] = 'Homework mode: we turn your questions into self-check cards instead.';
    allowed = new Set(settings.types.filter(t => ['flash', 'selfcheck'].includes(t)));
  } else if (stats.words < 150) {
    notices.push('Short text — fewer items.');
    for (const t of settings.types) if (!['flash', 'cloze', 'explain'].includes(t)) skipped[t] = 'Short text — add more to get this type.';
    allowed = new Set(settings.types.filter(t => ['flash', 'cloze', 'explain'].includes(t)));
  }
  const usable = (s: Sent) => !(docType === 'lesson' && SKIP_SECTIONS.test(sections[s.section].title));
  // Teacher-facing lesson sections feed "explain it back" prompts, not quiz items.
  const quizzable = (s: Sent) => usable(s) && !(docType === 'lesson' && TEACHER_SECTIONS.test(sections[s.section].title));
  const glossaryLine = (s: Sent) => /^[^:]{2,50}:\s/.test(s.text);
  // Show "evaporation", not "Evaporation" just because it opened a sentence.
  const shown = (d: Def) => terms.get(d.key)?.text ?? d.term;
  const sentScore = (s: Sent) => s.chunks.reduce((n, c) => n + (terms.get(c.key)?.score ?? 0), 0) / Math.sqrt(s.stems.length + 1);
  const ranked = [...terms.values()].sort((a, b) => b.score - a.score);
  const topKeys = new Set(ranked.filter(t => t.cls !== 'date').slice(0, Math.max(10, Math.ceil(ranked.length * 0.2))).map(t => t.key));
  const cands: Cand[] = [];
  const add = (type: ItemType, payload: Payload, conf: number, sent: Sent, context?: string) => cands.push({ type, payload, conf: Math.round(conf * 100) / 100, sent, context });
  const prevText = (s: Sent) => sents[s.i - 1]?.text;
  const pronounLed = (s: Sent) => PRONOUN_LEAD.has(words(s.text)[0] ?? '');
  const essayMcq = docType === 'essay' ? 0.8 : 1;

  // Sentence quizzability.
  const quiz = new Map<Sent, number>();
  for (const s of sents) {
    if (!quizzable(s) || s.kind === 'heading') continue;
    const wc = s.text.split(/\s+/).length;
    if (wc < 6 || wc > 40 || /\?$/.test(s.text)) continue;
    if (docType !== 'essay' && words(s.text).some(w => FIRST_SECOND.has(w))) continue;
    if ((s.text.match(/"([^"]+)"/)?.[1].split(/\s+/).length ?? 0) > 15) continue;
    let q = 0;
    if (s.chunks.some(c => topKeys.has(c.key))) q += 1;
    if (YEAR.test(s.text) || /\d/.test(s.text) || s.chunks.some(c => ['person', 'place', 'org'].includes(c.cls))) q += 0.5;
    if (CAUSAL.test(s.text)) q += 0.5;
    if (ENUMERATION.test(s.text)) q += 0.5;
    if (q > 0) quiz.set(s, q);
  }
  const quizSents = [...quiz.entries()].sort((a, b) => b[1] - a[1] || a[0].i - b[0].i).map(e => e[0]);

  // Flashcards: term → meaning.
  for (const d of defs) {
    if (!usable(d.sent)) continue;
    add('flash', { t: 'flash', front: shown(d), back: capitalize(d.def) }, d.conf, d.sent);
  }
  // Flashcards: facts. Heading → top sentence of that section; year → event.
  sections.forEach((sec, si) => {
    if (!si || sec.title.split(/\s+/).length > 8 || !['reading', 'lesson'].includes(docType)) return;
    const inSec = quizSents.filter(s => s.section === si);
    const best = inSec.filter(s => !pronounLed(s) && !glossaryLine(s)).sort((a, b) => sentScore(b) - sentScore(a))[0];
    if (inSec.length >= 2 && best && !terms.get(keyOf(sec.title))?.def) add('flash', { t: 'flash', front: sec.title, back: best.text }, 0.65, best);
  });
  const yearCount = new Map<string, number>();
  for (const s of sents) for (const y of s.text.match(new RegExp(YEAR.source, 'g')) ?? []) yearCount.set(y, (yearCount.get(y) ?? 0) + 1);
  for (const s of quizSents) {
    const y = s.text.match(YEAR)?.[1];
    if (y && yearCount.get(y) === 1 && !pronounLed(s)) add('flash', { t: 'flash', front: `What happened in ${y}?`, back: s.text }, 0.65, s);
  }

  // Cloze.
  // Prefer defined terms; a word in most sentences is the topic itself and makes an easy blank.
  const blankable = (s: Sent) =>
    s.chunks
      .filter(c => c.text.split(' ').length <= 4)
      .map(c => {
        const t = terms.get(c.key);
        const everywhere = sents.length > 3 && (t?.sents.size ?? 0) / sents.length > 0.4;
        return { c, score: (t?.score ?? 0) * (t?.def ? 2 : 1) * (everywhere ? 0.5 : 1) };
      })
      .sort((a, b) => b.score - a.score)[0]?.c;
  const clozeOf = (s: Sent, c: Chunk) => {
    const re = new RegExp(`\\b${escapeRe(c.text)}\\b`, 'i');
    const text = s.text.replace(re, '________');
    if (text === s.text) return null;
    const repeats = (s.text.match(new RegExp(`\\b${escapeRe(c.text)}\\b`, 'gi')) ?? []).length;
    return { text, repeats };
  };
  for (const s of quizSents) {
    const c = blankable(s);
    if (!c) continue;
    const z = clozeOf(s, c);
    if (!z) continue;
    let conf = 1;
    if (z.repeats > 1) conf *= 0.3;
    const pl = pronounLed(s);
    if (pl) conf *= prevText(s) ? 0.75 : 0.6;
    const letters = c.text.replace(/[^A-Za-z0-9]/g, '').length;
    add('cloze', { t: 'cloze', text: z.text, answer: c.text, hint: `${c.text[0].toLowerCase()}, ${letters} letters`, context: pl ? prevText(s) : undefined }, conf, s);
  }

  // Distractors (§8.5).
  const sameClass = (a: Cls, b: Cls) => a === b;
  const distract = (answerKey: string, answer: string, cls: Cls, stem: string, section: number): string[] => {
    if (cls === 'date') {
      const ys = [...terms.values()].filter(t => t.cls === 'date' && t.key !== answerKey).map(t => t.text);
      const max = Math.max(...[...terms.values()].filter(t => t.cls === 'date').map(t => +t.text));
      const out = new Set(ys);
      for (let k = 1; out.size < 6 && k < 60; k++) {
        const y = +answer + (k % 2 ? 1 : -1) * (1 + ((k * 7) % 30));
        if (y <= max && y !== +answer) out.add(String(y));
      }
      return [...out].slice(0, 6);
    }
    const a = answer.toLowerCase();
    const stemL = stem.toLowerCase();
    return [...terms.values()]
      .filter(t => t.key !== answerKey && sameClass(t.cls, cls))
      .filter(t => {
        const x = t.text.toLowerCase();
        return !x.includes(a) && !a.includes(x) && !stemL.includes(x) && editDistance(x, a) > 2 && x.length >= a.length * 0.5 && x.length <= a.length * 2;
      })
      .map(t => ({ t, d: Math.min(...[...t.sections].map(x => Math.abs(x - section))) }))
      .sort((x, y) => x.d - y.d || y.t.score - x.t.score)
      .slice(0, 6)
      .map(x => x.t.text);
  };

  // MCQ: "Which term means …?" from definitions, then cloze stems.
  for (const d of defs) {
    const t = terms.get(d.key);
    if (!usable(d.sent) || !t) continue;
    if (!quizzable(d.sent)) continue;
    const stemText = `Which term means: "${d.def}"?`;
    const pool = distract(d.key, d.term, t.cls, d.def, d.sent.section);
    if (pool.length < 3) continue; // converted to cloze: never pad
    add('mcq', { t: 'mcq', stem: stemText, answer: shown(d), pool }, d.conf * (pool.length < 6 ? 0.85 : 1) * essayMcq, d.sent);
  }
  for (const s of quizSents) {
    const c = blankable(s);
    if (!c) continue;
    const z = clozeOf(s, c);
    if (!z) continue;
    const pool = distract(c.key, c.text, c.cls, s.text, s.section);
    if (pool.length < 3) continue;
    let conf = (pool.length < 6 ? 0.85 : 1) * essayMcq;
    if (z.repeats > 1) conf *= 0.3;
    if (pronounLed(s)) conf *= prevText(s) ? 0.75 : 0.6;
    add('mcq', { t: 'mcq', stem: z.text, answer: c.text, pool }, conf, s, pronounLed(s) ? prevText(s) : undefined);
  }

  // True/False (§8.6).
  const falsify = (s: Sent): string | null => {
    const text = s.text;
    for (const c of s.chunks) {
      if (c.cls === 'date' || !topKeys.has(c.key)) continue;
      const swap = ranked.find(t => t.key !== c.key && t.cls === c.cls && topKeys.has(t.key) && t.sections.has(s.section) && !text.toLowerCase().includes(t.text.toLowerCase()) && editDistance(t.text.toLowerCase(), c.text.toLowerCase()) > 2);
      if (swap) {
        const atStart = text.startsWith(c.text);
        let out = text.replace(new RegExp(`\\b${escapeRe(c.text)}\\b`), atStart ? capitalize(swap.text) : swap.text);
        out = out.replace(new RegExp(`\\b(a|an|A|An) (${escapeRe(swap.text)})\\b`, 'i'), (_, art: string, w: string) => {
          const an = /^[aeiou]/i.test(w);
          return (/^A/.test(art) ? (an ? 'An' : 'A') : an ? 'an' : 'a') + ' ' + w;
        });
        if (out !== text) return out;
      }
    }
    const y = text.match(YEAR)?.[1];
    if (y) {
      const pool = distract(y, y, 'date', text, s.section);
      if (pool.length) return text.replace(y, pool[r.int(pool.length)]);
    }
    const n = text.match(/\b(\d+(?:\.\d+)?)\b/);
    if (n && !YEAR.test(n[1])) {
      const v = +n[1], dec = n[1].split('.')[1]?.length ?? 0;
      const f = (1 + (0.1 + r.next() * 0.4) * (r.next() < 0.5 ? -1 : 1));
      const nv = (v * f).toFixed(dec);
      if (nv !== n[1] && +nv > 0) return text.replace(n[1], nv);
    }
    const cm = text.match(/^(?:the )?([\w ]{2,40}?) (causes|leads to|cause|lead to) ([\w ]{2,40}?)\.?$/i);
    if (cm && cm[1].split(' ').length <= 5 && cm[3].split(' ').length <= 5) return `${capitalize(cm[3])} ${cm[2]} ${cm[1].toLowerCase()}.`;
    for (const [a, b] of ANTONYMS) {
      for (const [x, y2] of [[a, b], [b, a]]) {
        const re = new RegExp(`\\b${x}\\b`, 'i');
        if (re.test(text)) return text.replace(re, m => (/^[A-Z]/.test(m) ? capitalize(y2) : y2));
      }
    }
    return null;
  };
  let nTrue = 0, nFalse = 0;
  if (docType === 'essay') skipped.tf = "Opinion writing doesn't make fair true/false items.";
  else for (const s of quizSents) {
    if (pronounLed(s) || glossaryLine(s)) continue;
    const statement = s.text.replace(/^(however|also|in addition|additionally|furthermore|moreover|for example|finally|first|second|third|then),\s*/i, '').replace(/^./, c => c.toUpperCase());
    const conf = NEGATION.test(s.text) ? 0.5 : 1;
    const wantFalse = nFalse < nTrue || (nFalse === nTrue && r.next() < 0.5);
    const f = wantFalse ? falsify({ ...s, text: statement }) : null;
    if (f) { add('tf', { t: 'tf', statement: f, answer: false, original: s.text }, conf, s); nFalse++; }
    else { add('tf', { t: 'tf', statement, answer: true, original: s.text }, conf, s); nTrue++; }
  }

  // Matching: 4–8 term/definition pairs, same section first.
  const usedInMatch = new Set<Def>();
  const groups = new Map<number, Def[]>();
  for (const d of defs) if (usable(d.sent)) groups.set(d.sent.section, [...(groups.get(d.sent.section) ?? []), d]);
  const makeMatch = (ds: Def[]) => {
    for (let k = 0; k + 4 <= ds.length; k += 8) {
      const g = ds.slice(k, k + 8);
      if (g.length < 4) break;
      g.forEach(d => usedInMatch.add(d));
      add('match', { t: 'match', pairs: g.map(d => [shown(d), trimWords(capitalize(d.def), 15)]) }, Math.min(...g.map(d => d.conf)), g[0].sent);
    }
  };
  for (const ds of groups.values()) if (ds.length >= 4) makeMatch(ds);
  const rest = defs.filter(d => usable(d.sent) && !usedInMatch.has(d));
  if (rest.length >= 4) makeMatch(rest);

  // Sequence: numbered steps, or ≥4 dated events in one section.
  for (let i = 0; i < sents.length; ) {
    const s = sents[i];
    if (s.ordered && s.idx === 0) {
      const run: Sent[] = [];
      while (i < sents.length && sents[i].ordered && sents[i].section === s.section) { if (sents[i].idx === 0) run.push(sents[i]); i++; }
      const steps = run.map(x => sents.filter(y => y.blockId === x.blockId).map(y => y.text).join(' '));
      if (run.length >= 3 && run.length <= 8 && steps.every(t => t.split(/\s+/).length <= 25) && usable(s))
        add('sequence', { t: 'sequence', prompt: `Put these in order${sections[s.section].title ? `: ${sections[s.section].title}` : ''}`, steps }, 0.9, run[0]);
    } else i++;
  }
  sections.forEach((_, si) => {
    const dated = quizSents.filter(s => s.section === si && YEAR.test(s.text) && !pronounLed(s));
    const byYear = new Map<string, Sent>();
    for (const s of dated) byYear.set(s.text.match(YEAR)![1], byYear.get(s.text.match(YEAR)![1]) ?? s);
    if (byYear.size < 4) return;
    const ordered = [...byYear.entries()].sort((a, b) => +a[0] - +b[0]).slice(0, 8);
    add('sequence', { t: 'sequence', prompt: 'Put these events in order, earliest first', steps: ordered.map(([y, s]) => s.text.replace(y, '____')) }, 0.8, ordered[0][1]);
  });

  // Explain it back.
  const topDefs = defs.filter(d => usable(d.sent)).sort((a, b) => (terms.get(b.key)?.score ?? 0) - (terms.get(a.key)?.score ?? 0)).slice(0, 8);
  for (const d of topDefs) add('explain', { t: 'explain', prompt: `Explain ${shown(d)} in your own words.`, answer: d.sent.text }, 0.9 * d.conf, d.sent);
  for (const s of sents) {
    if (!usable(s)) continue;
    let m;
    let effect: string | undefined, cause: string | undefined;
    if ((m = s.text.match(/^Because (.+?), (.+?)\.?$/))) [cause, effect] = [m[1], m[2]];
    else if ((m = s.text.match(/^(.{8,}?),? because (?:of )?(.+?)\.?$/))) [effect, cause] = [m[1], m[2]];
    if (effect && cause && !PRON_START.test(effect)) {
      const q = whyQuestion(effect);
      if (q) add('explain', { t: 'explain', prompt: q, answer: `Because ${cause}.` }, 0.75, s);
    }
    if (quizzable(s) && (m = s.text.match(ENUMERATION))) {
      const of = s.text.slice(m.index! + m[0].length).match(/^ of ([a-z][a-z -]{2,40}?)(?= are| include|:|,|\.|$)/i);
      if (of) add('explain', { t: 'explain', prompt: `What are the ${m[1].toLowerCase()} ${m[2].toLowerCase()} of ${of[1]}?`, answer: [s.text, /:$/.test(s.text) || s.text.split(' ').length < 12 ? sents[s.i + 1]?.text : ''].filter(Boolean).join(' ') }, 0.8, s);
    }
    if (docType === 'lesson' && s.kind === 'listItem' && /objective|goal|target|swbat/i.test(sections[s.section].title)) {
      const o = s.text.replace(/^(students|swbat|i|learners)( will| can)?( be able to)?\s+/i, '').replace(/\.$/, '');
      if (o.split(' ').length >= 3) add('explain', { t: 'explain', prompt: `${capitalize(o)}.`, answer: 'Check your answer against the lesson.' }, 0.85, s);
    }
  }

  // Essay: "defend your claim" prompts from claim-like sentences in the opening and closing paragraphs.
  if (docType === 'essay') {
    const lastPara = sents[sents.length - 1]?.para;
    for (const s of sents)
      if ((s.para <= 1 || s.para === lastPara) && /\b(should|believe|think|argue|must|need to)\b/i.test(s.text) && !/\?$/.test(s.text))
        add('explain', { t: 'explain', prompt: `Defend this claim with your own evidence: "${s.text}"`, answer: 'Compare your reasons with the body paragraphs of your essay.' }, 0.8, s);
  }

  // Worksheet self-check.
  if (docType === 'homework') {
    for (const b of blocks) {
      if (b.kind === 'heading' || !(/\?$/.test(b.text) || /_{3,}/.test(b.text) || (b.kind === 'listItem' && b.ordered))) continue;
      const s = sents.find(x => x.blockId === b.id);
      const question = b.text.replace(/\s*_{3,}\s*/g, ' ').trim();
      if (s && question.split(/\s+/).length >= 3) add('selfcheck', { t: 'selfcheck', question }, 0.9, s);
    }
  } else skipped.selfcheck ??= 'Only made from homework and worksheets.';

  // Dedupe, cap, balance.
  const items: Item[] = [];
  const textOf = (p: Payload) => contentStems(Object.values(p).filter(v => typeof v === 'string').join(' '));
  const byType = new Map<ItemType, Cand[]>();
  for (const c of cands) if (allowed.has(c.type)) byType.set(c.type, [...(byType.get(c.type) ?? []), c]);
  const picked = new Map<ItemType, { shown: Cand[]; hidden: Cand[] }>();
  for (const [type, list] of byType) {
    const kept: { c: Cand; stems: string[] }[] = [];
    for (const c of list.sort((a, b) => b.conf - a.conf)) {
      const st = textOf(c.payload);
      if (!kept.some(k => jaccard(k.stems, st) >= 0.7)) kept.push({ c, stems: st });
      if (kept.length >= CAPS[type] * 4) break;
    }
    const cap = type === 'mcq' && docType === 'essay' ? ESSAY_MCQ_CAP : CAPS[type];
    const shown = roundRobin(kept.map(k => k.c).filter(c => c.conf >= THRESHOLD)).slice(0, cap);
    const hidden = kept.map(k => k.c).filter(c => c.conf < THRESHOLD).slice(0, CAPS[type]);
    picked.set(type, { shown, hidden });
  }
  if (settings.count !== 'auto') {
    // Allocate the requested count across types one at a time, in difficulty order.
    const order = ORDER[settings.difficulty].filter(t => picked.has(t));
    const take = new Map(order.map(t => [t, 0]));
    let left = settings.count, moved = true;
    while (left > 0 && moved) {
      moved = false;
      for (const t of order) if (left > 0 && take.get(t)! < picked.get(t)!.shown.length) { take.set(t, take.get(t)! + 1); left--; moved = true; }
    }
    for (const t of order) picked.get(t)!.shown = picked.get(t)!.shown.slice(0, take.get(t));
  }
  let n = 0;
  for (const type of ORDER[settings.difficulty]) {
    const p = picked.get(type);
    if (!allowed.has(type)) { skipped[type] ??= settings.types.includes(type) ? 'Not made for this kind of document.' : 'Turned off.'; continue; }
    if (!p || (!p.shown.length && !p.hidden.length)) { skipped[type] ??= reasonFor(type); continue; }
    for (const [list, status] of [[p.shown, 'active'], [p.hidden, 'hidden']] as const)
      for (const c of list)
        items.push({
          id: `${idPrefix}${n++}`, sourceId, type: c.type, payload: c.payload, confidence: c.conf, status, seed,
          sourceRef: { blockId: c.sent.blockId, sentenceIdx: c.sent.idx, text: c.sent.text, context: c.context ?? (c.type === 'cloze' ? (c.payload as { context?: string }).context : undefined) },
          createdAt: 0,
        });
  }
  return { docType, stats, items, notices, skipped, restate: restate(A, items) };
}

function reasonFor(type: ItemType): string {
  return {
    flash: 'No definitions or key facts found.',
    cloze: 'No sentences with clear key terms found.',
    mcq: 'Not enough similar terms to make fair wrong answers.',
    tf: 'No sentences we could safely turn into true/false.',
    match: 'Needs at least 4 terms with definitions.',
    sequence: 'No numbered steps or dated events found.',
    explain: 'No definitions, causes or lists found.',
    selfcheck: 'No questions found in the document.',
  }[type];
}

function roundRobin(list: Cand[]): Cand[] {
  const bySec = new Map<number, Cand[]>();
  for (const c of list) bySec.set(c.sent.section, [...(bySec.get(c.sent.section) ?? []), c]);
  const queues = [...bySec.values()];
  const out: Cand[] = [];
  while (queues.some(q => q.length)) for (const q of queues) if (q.length) out.push(q.shift()!);
  return out;
}

const AUX = /^(is|are|was|were|can|could|will|would|should|must|may|might|has|have|had|does|do|did)$/i;
export function whyQuestion(effect: string): string | null {
  const e = effect.replace(/\.$/, '');
  const ws = e.split(/\s+/);
  const ai = ws.findIndex(w => AUX.test(w));
  const doc = nlp(e);
  const v = doc.verbs().first();
  if (!v.found) return null;
  const vText = v.text().split(/\s+/)[0];
  const vi = ws.findIndex(w => w.replace(/\W/g, '') === vText.replace(/\W/g, ''));
  if (ai > 0 && (vi < 0 || ai <= vi)) return `Why ${ws[ai].toLowerCase()} ${lowerFirst(ws.slice(0, ai).join(' '))} ${ws.slice(ai + 1).join(' ')}?`;
  if (vi < 1) return null;
  const subj = ws.slice(0, vi).join(' ');
  const json = v.json()[0] as { verb?: { infinitive?: string; grammar?: { tense?: string } } } | undefined;
  const inf = json?.verb?.infinitive ?? vText;
  const tense = json?.verb?.grammar?.tense;
  const plural = /s$/i.test(ws[vi - 1]) && !/ss$/i.test(ws[vi - 1]) || /^(i|you|we|they)$/i.test(subj);
  const aux = tense === 'PastTense' ? 'did' : plural ? 'do' : 'does';
  return `Why ${aux} ${lowerFirst(subj)} ${inf} ${ws.slice(vi + 1).join(' ')}`.trim() + '?';
}
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) && !nlp(s).terms().first().has('#ProperNoun') ? s[0].toLowerCase() + s.slice(1) : s);

// --- Restatements (§8.8) --------------------------------------------------

function restate(A: Analysis, items: Item[]): Restatements {
  const { sents, sections, terms, defs, blocks } = A;
  const sentScore = (s: Sent) => s.chunks.reduce((n, c) => n + (terms.get(c.key)?.score ?? 0), 0) / Math.sqrt(s.stems.length + 1);
  // ponytail: O(n²) sentence graph; capped at 600 best sentences for very long documents.
  const pool = sents.length > 600 ? [...sents].sort((a, b) => sentScore(b) - sentScore(a)).slice(0, 600) : sents.filter(s => s.text.split(' ').length >= 5);
  const sets = pool.map(s => new Set(s.stems));
  const W = pool.map((_, a) => pool.map((__, b) => {
    if (a === b) return 0;
    let c = 0;
    for (const x of sets[a]) if (sets[b].has(x)) c++;
    return c ? c / (Math.log(sets[a].size + 1) + Math.log(sets[b].size + 1)) : 0;
  }));
  let pr = pool.map(() => 1);
  for (let it = 0; it < 25; it++) {
    pr = pool.map((_, b) => 0.15 + 0.85 * pool.reduce((n, __, a) => {
      const tot = W[a].reduce((x, y) => x + y, 0);
      return tot ? n + (pr[a] * W[a][b]) / tot : n;
    }, 0));
  }
  const nKey = Math.min(pool.length, Math.max(Math.min(5, pool.length), Math.min(10, Math.round(pool.length / 8))));
  const top = pool.map((s, i) => ({ s, p: pr[i] })).sort((a, b) => b.p - a.p).slice(0, nKey).map(x => x.s).sort((a, b) => a.i - b.i);
  const keyPoints = top.map(s => {
    const prev = sents[s.i - 1];
    const needsContext = PRONOUN_LEAD.has(words(s.text)[0] ?? '') && prev && !top.includes(prev);
    return { text: needsContext ? `${prev.text} ${s.text}` : s.text, blockId: s.blockId };
  });

  const outline = sections.slice(1).map((sec, k) => {
    const inSec = sents.filter(s => s.section === k + 1).sort((a, b) => sentScore(b) - sentScore(a));
    return { title: sec.title, level: sec.level, top: inSec[0]?.text };
  });
  const glossary = [...defs].sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' })).map(d => ({ term: d.term, def: capitalize(d.def), blockId: d.sent.blockId }));

  const original = blocks.filter(b => b.kind !== 'heading').map(b => b.text).join('\n\n');
  const simplifiedText = blocks
    .map(b => (b.kind === 'heading' ? b.text : splitSentences(b.text).map(simplifySentence).join(' ')))
    .join('\n\n');
  const simplifiedBody = blocks.filter(b => b.kind !== 'heading').map(b => splitSentences(b.text).map(simplifySentence).join(' ')).join('\n\n');
  return {
    keyPoints,
    outline,
    glossary,
    simplified: { text: simplifiedText, gradeBefore: fkGrade(original), gradeAfter: fkGrade(simplifiedBody) },
    sayItBack: items.filter(i => i.type === 'explain' && i.status === 'active').map(i => (i.payload as { prompt: string }).prompt),
  };
}

export function simplifySentence(s: string): string {
  let out = s.replace(/\s*\([^)]*\)/g, '');
  out = out.replace(/[A-Za-z]+/g, w => {
    const sw = PLAIN_SWAPS[w.toLowerCase()];
    return sw ? (/^[A-Z]/.test(w) ? capitalize(sw) : sw) : w;
  });
  const parts = out.split(/;\s*/).map(p => p.trim()).filter(Boolean);
  return parts
    .flatMap(p => {
      if (p.split(/\s+/).length <= 25) return [p];
      const m = p.match(/^(.+?), (which|and) (.+)$/);
      if (!m || m[1].split(/\s+/).length < 5) return [p];
      return [m[1], (m[2] === 'which' ? 'This ' : '') + m[3]];
    })
    .map(p => capitalize(p.replace(/[.;,!?]*$/, '')) + (p.match(/[!?]$/)?.[0] ?? '.'))
    .join(' ');
}
