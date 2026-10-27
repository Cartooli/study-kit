import { useRef, useState } from 'preact/hooks';
import { go, TYPE_LABEL } from './app.tsx';
import type { GenResult } from './engine/generate.ts';
import type { Extracted } from './engine/extract.ts';
import * as store from './store.ts';
import { ITEM_TYPES, type Deck, type DocType, type GenSettings, type ItemType, type Source } from './types.ts';
import { TYPE_NAMES } from './util.ts';
import { runWorker } from './worker-client.ts';

type Loaded = Extracted & { docType: DocType; words: number; name: string; mime: string; size: number };
const ACCEPT = '.txt,.md,.markdown,.docx,.pptx,.pdf,.png,.jpg,.jpeg,text/plain,text/markdown,application/pdf';
const MAX_BYTES = 20 * 1024 * 1024;

export function LoadView() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [paste, setPaste] = useState('');
  const [over, setOver] = useState(false);
  const [title, setTitle] = useState('');
  const [types, setTypes] = useState<ItemType[]>(ITEM_TYPES);
  const [count, setCount] = useState<GenSettings['count']>('auto');
  const [difficulty, setDifficulty] = useState<GenSettings['difficulty']>('recall');
  const cancelRef = useRef<() => void>(() => {});

  const run = async <T,>(label: string, job: { promise: Promise<T>; cancel: () => void }): Promise<T | null> => {
    setBusy(label);
    setError('');
    cancelRef.current = job.cancel;
    try {
      return await job.promise;
    } catch (e) {
      if ((e as Error).message !== 'Cancelled.') setError((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const openFile = async (f: File) => {
    if (f.size > MAX_BYTES) return setError('That file is over 20 MB. Try a smaller file or paste the text.');
    if (/\.(doc|rtf|odt|pages)$/i.test(f.name)) return setError('Save it as PDF or DOCX, or paste the text.');
    const bytes = await f.arrayBuffer();
    const r = await run('Reading your file…', runWorker<Loaded>({ op: 'extract', name: f.name, mime: f.type, bytes }, [bytes]));
    if (r) accept({ ...r, name: f.name, mime: f.type || 'application/octet-stream', size: f.size });
  };
  const openPaste = async () => {
    const r = await run('Reading your text…', runWorker<Loaded>({ op: 'extract', name: 'Pasted text', mime: 'text/plain', text: paste }));
    if (r) accept({ ...r, name: 'Pasted text', mime: 'text/plain', size: paste.length });
  };
  const accept = (r: Loaded) => {
    if (r.words < 25) return setError(r.emptyPages?.length ? 'These pages look like scanned images, so there is no text to read. Paste the text instead.' : 'Add a bit more text to make study cards.');
    setLoaded(r);
    const heading = r.blocks.find(b => b.kind === 'heading')?.text;
    setTitle((heading ?? r.name.replace(/\.[^.]+$/, '')).slice(0, 120));
  };

  const make = async () => {
    if (!loaded) return;
    const sourceId = store.uid();
    const settings: GenSettings = { types, count, difficulty };
    const seed = 1;
    const res = await run('Making your study set…', runWorker<GenResult>({ op: 'generate', blocks: loaded.blocks, settings, seed, sourceId, idPrefix: sourceId.slice(0, 8) + '-' }));
    if (!res) return;
    const now = Date.now();
    const items = res.items.map(i => ({ ...i, createdAt: now }));
    const source: Source = {
      id: sourceId, title, fileName: loaded.name, mime: loaded.mime, sizeBytes: loaded.size,
      textHash: await store.sha256(loaded.blocks.map(b => b.text).join('\n')), docType: res.docType, blocks: loaded.blocks,
      stats: { ...res.stats, pages: loaded.pages }, createdAt: now, restate: res.restate,
    };
    const deck: Deck = { id: store.uid(), title: title || 'Study set', sourceIds: [sourceId], itemIds: items.map(i => i.id), settings: { ...settings, seed }, createdAt: now, updatedAt: now };
    await store.saveNewDeck(source, items, deck);
    try { sessionStorage.setItem(`studykit:notes:${deck.id}`, JSON.stringify({ notices: res.notices, skipped: res.skipped })); } catch { /* storage blocked: notes are optional */ }
    go(`deck/${deck.id}/check`);
  };

  const toggle = (t: ItemType) => setTypes(ts => (ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t]));

  if (busy)
    return (
      <div class="stack" aria-busy="true">
        <h1>{busy}</h1>
        <progress aria-label={busy} />
        <button onClick={() => cancelRef.current()}>Cancel</button>
      </div>
    );

  if (loaded)
    return (
      <div class="stack">
        <h1>Make a study set</h1>
        <div class="card">
          <p><strong>{loaded.name}</strong></p>
          <p>We read {loaded.words.toLocaleString()} words{loaded.pages ? ` from ${loaded.pages} page${loaded.pages === 1 ? '' : 's'}` : ''}. Looks like: {TYPE_LABEL[loaded.docType]}. About {Math.max(1, Math.round(loaded.words / 200))} min to read.</p>
          {!!loaded.emptyPages?.length && <p class="error">Pages {loaded.emptyPages.join(', ')} look like scanned images, so we couldn't read them. Paste their text if you need it.</p>}
          {loaded.words < 150 && <p class="muted">Short text — fewer items.</p>}
          {loaded.docType === 'math' && <p class="muted">Study Kit works best on reading material. We'll make vocabulary cards only.</p>}
        </div>
        <label class="check">Name <input type="text" value={title} maxLength={120} onInput={e => setTitle((e.target as HTMLInputElement).value)} /></label>
        <fieldset>
          <legend>What to make</legend>
          {ITEM_TYPES.map(t => (
            <label class="check" key={t}><input type="checkbox" checked={types.includes(t)} onChange={() => toggle(t)} /> {TYPE_NAMES[t]}</label>
          ))}
        </fieldset>
        <fieldset>
          <legend>How many</legend>
          {(['auto', 10, 20, 40] as const).map(c => (
            <label class="check" key={c}><input type="radio" name="count" checked={count === c} onChange={() => setCount(c)} /> {c === 'auto' ? 'As many good ones as we can find' : c}</label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Kind of practice</legend>
          <label class="check"><input type="radio" name="diff" checked={difficulty === 'recall'} onChange={() => setDifficulty('recall')} /> Recall (say or type the answer)</label>
          <label class="check"><input type="radio" name="diff" checked={difficulty === 'recognition'} onChange={() => setDifficulty('recognition')} /> Recognition (pick the answer)</label>
        </fieldset>
        {error && <p class="error" role="alert">{error}</p>}
        <div class="row">
          <button class="primary" disabled={!types.length} onClick={make}>Make study set</button>
          <button onClick={() => setLoaded(null)}>Start over</button>
        </div>
      </div>
    );

  return (
    <div class="stack">
      <h1>Make a study set</h1>
      <p>Open a handout, notes, an essay or a PDF. It never leaves this device.</p>
      <label
        class={`drop${over ? ' over' : ''}`}
        onDragOver={e => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer?.files[0];
          if (f) openFile(f);
        }}
      >
        <input type="file" accept={ACCEPT} onChange={e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) openFile(f); }} />
        <strong>Drop a file here or choose one</strong>
        <br />
        <span class="muted">PDF, Word (.docx), PowerPoint (.pptx), text or Markdown · up to 20 MB</span>
      </label>
      <h2>Or paste text</h2>
      <label for="paste" class="muted">Paste your notes, a reading or a lesson plan</label>
      <textarea id="paste" value={paste} maxLength={300000} onInput={e => setPaste((e.target as HTMLTextAreaElement).value)} />
      {error && <p class="error" role="alert">{error}</p>}
      <button class="primary" disabled={!paste.trim()} onClick={openPaste}>Use this text</button>
    </div>
  );
}
