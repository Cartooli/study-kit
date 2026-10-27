import { decodeText, kindOf, parseDocx, parsePptx, parseText, UserError, type Extracted } from './engine/extract.ts';
import { detectType, generate } from './engine/generate.ts';
import { extractPdf } from './engine/pdf.ts';
import type { Block, GenSettings } from './types.ts';

export type WorkerReq =
  | { op: 'extract'; name: string; mime: string; bytes?: ArrayBuffer; text?: string }
  | { op: 'generate'; blocks: Block[]; settings: GenSettings; seed: number; sourceId: string; idPrefix: string };

async function extract(m: Extract<WorkerReq, { op: 'extract' }>): Promise<Extracted & { docType: string; words: number }> {
  let out: Extracted;
  if (m.text !== undefined) out = { blocks: parseText(m.text) };
  else {
    const bytes = new Uint8Array(m.bytes!);
    const kind = kindOf(m.name, m.mime);
    if (kind === 'docx') out = { blocks: parseDocx(bytes) };
    else if (kind === 'pptx') out = { blocks: parsePptx(bytes) };
    else if (kind === 'pdf') out = await extractPdf(bytes);
    else if (kind === 'text') out = { blocks: parseText(decodeText(bytes)) };
    else if (kind === 'image') throw new UserError("Pictures and scans need a scan reader, which this version doesn't include. Paste the text instead.");
    else throw new UserError('Save it as PDF or DOCX, or paste the text.');
  }
  const words = out.blocks.reduce((n, b) => n + b.text.split(/\s+/).length, 0);
  return { ...out, docType: detectType(out.blocks, []), words };
}

self.onmessage = async (e: MessageEvent<WorkerReq>) => {
  const m = e.data;
  try {
    const result = m.op === 'extract' ? await extract(m) : generate(m.blocks, m.settings, m.seed, m.sourceId, m.idPrefix);
    postMessage({ ok: true, result });
  } catch (err) {
    if (!(err instanceof UserError)) console.error(err);
    postMessage({ ok: false, error: err instanceof UserError ? err.message : "Something went wrong reading that. Try a smaller section or paste the text." });
  }
};
