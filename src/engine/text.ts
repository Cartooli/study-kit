import { ABBREVIATIONS, STOPWORDS } from './words.ts';

export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[­​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const s = segment.trim();
    if (!s) continue;
    const prev = out[out.length - 1];
    // Merge splits after abbreviations ("Dr.", "U.S.") and single capital initials ("J.").
    const last = prev?.match(/(\S+)\.$/)?.[1];
    if (prev && last && (ABBREVIATIONS.has(last.toLowerCase()) || /^[A-Z]$/.test(last))) out[out.length - 1] = prev + ' ' + s;
    else out.push(s);
  }
  return out;
}

export const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) ?? [];

// ponytail: suffix-stripping stemmer, not Porter; good enough for within-document matching.
export function stem(w: string): string {
  w = w.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(ches|shes|xes|sses|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2);
  return w;
}

export const contentStems = (s: string): string[] => words(s).filter(w => !STOPWORDS.has(w) && !/^\d+$/.test(w)).map(stem);

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

// Optimal string alignment (restricted Damerau–Levenshtein).
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

const answerNorm = (s: string) => words(s).filter(w => !/^(a|an|the)$/.test(w));

// Typed-answer check for cloze: case/punctuation-insensitive, stem match, one typo allowed on words of 5+ letters.
export function answerMatches(given: string, answer: string): boolean {
  const g = answerNorm(given), a = answerNorm(answer);
  if (!g.length || g.length !== a.length) return false;
  return a.every((w, i) => w === g[i] || stem(w) === stem(g[i]) || (w.length >= 5 && editDistance(w, g[i]) <= 1));
}

export function syllables(w: string): number {
  w = w.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, w.match(/[aeiouy]{1,2}/g)?.length ?? 1);
}

// Flesch–Kincaid grade level (public formula).
export function fkGrade(text: string): number {
  const sents = splitSentences(text).length || 1;
  const ws = words(text);
  if (!ws.length) return 0;
  const syl = ws.reduce((n, w) => n + syllables(w), 0);
  return Math.round((0.39 * (ws.length / sents) + 11.8 * (syl / ws.length) - 15.59) * 10) / 10;
}

// Seeded PRNG (mulberry32) so the same document + settings + seed gives the same items.
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    shuffle<T>(arr: T[]): T[] {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function trimWords(s: string, n: number): string {
  const w = s.split(/\s+/);
  return w.length <= n ? s : w.slice(0, n).join(' ') + '…';
}
