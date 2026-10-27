export type BlockKind = 'heading' | 'paragraph' | 'listItem' | 'tableRow' | 'caption';
export type Block = {
  id: string; kind: BlockKind; level?: number; text: string; page?: number; order: number;
  ordered?: boolean; // numbered list item (drives "put in order" items)
};

export type DocType = 'lesson' | 'reading' | 'essay' | 'notes' | 'homework' | 'math';
export type ItemType = 'flash' | 'cloze' | 'mcq' | 'tf' | 'match' | 'sequence' | 'explain' | 'selfcheck';
export const ITEM_TYPES: ItemType[] = ['flash', 'cloze', 'mcq', 'tf', 'match', 'sequence', 'explain', 'selfcheck'];

export type SourceRef = { blockId: string; sentenceIdx: number; text: string; context?: string };

export type Payload =
  | { t: 'flash'; front: string; back: string }
  | { t: 'cloze'; text: string; answer: string; hint: string; context?: string }
  | { t: 'mcq'; stem: string; answer: string; pool: string[] } // options are drawn from pool per seed
  | { t: 'tf'; statement: string; answer: boolean; original: string }
  | { t: 'match'; pairs: [string, string][] }
  | { t: 'sequence'; prompt: string; steps: string[] } // steps in correct order
  | { t: 'explain'; prompt: string; answer: string }
  | { t: 'selfcheck'; question: string };

export type ItemStatus = 'active' | 'hidden' | 'deleted' | 'edited';
export type Item = {
  id: string; sourceId: string; type: ItemType; payload: Payload; confidence: number;
  sourceRef: SourceRef; status: ItemStatus; seed: number; createdAt: number; editedAt?: number;
};

export type GenSettings = {
  types: ItemType[];
  count: 'auto' | 10 | 20 | 40;
  difficulty: 'recall' | 'recognition';
};

export type Restatements = {
  keyPoints: { text: string; blockId: string }[];
  outline: { title: string; level: number; top?: string }[];
  glossary: { term: string; def: string; blockId: string }[];
  simplified: { text: string; gradeBefore: number; gradeAfter: number };
  sayItBack: string[];
};

export type Stats = { words: number; pages?: number; sentences: number; minutes: number };

export type Source = {
  id: string; title: string; fileName: string; mime: string; sizeBytes: number; textHash: string;
  docType: DocType; blocks: Block[]; stats: Stats; createdAt: number; restate?: Restatements;
};

export type Deck = {
  id: string; title: string; sourceIds: string[]; itemIds: string[]; settings: GenSettings & { seed: number };
  createdAt: number; updatedAt: number;
};
