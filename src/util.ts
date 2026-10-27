import { rng } from './engine/text.ts';
import type { Item } from './types.ts';

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeName = (s: string) => s.replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'study-set';

// MCQ options are drawn from the distractor pool per seed, so Version A/B can differ.
export function mcqOptions(item: Item, seed: number): string[] {
  if (item.payload.t !== 'mcq') return [];
  const r = rng(seed ^ hash(item.id));
  return r.shuffle([item.payload.answer, ...r.shuffle(item.payload.pool).slice(0, 3)]);
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const TYPE_NAMES: Record<Item['type'], string> = {
  flash: 'Flashcards', cloze: 'Fill in the blank', mcq: 'Multiple choice', tf: 'True or false', match: 'Matching',
  sequence: 'Put in order', explain: 'Explain it back', selfcheck: 'Self-check',
};
