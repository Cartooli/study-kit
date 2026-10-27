import { useEffect, useRef, useState } from 'preact/hooks';
import { useSettings } from './app.tsx';
import { cardFaces } from './io.ts';
import { SourceLine } from './questions.tsx';
import * as store from './store.ts';
import type { Item } from './types.ts';

const GRADES = [
  [store.Rating.Again, 'Again', '1'],
  [store.Rating.Hard, 'Hard', '2'],
  [store.Rating.Good, 'Good', '3'],
  [store.Rating.Easy, 'Easy', '4'],
] as const;

export function ReviewView({ deckId }: { deckId?: string }) {
  const { settings } = useSettings();
  const [queue, setQueue] = useState<store.QueueEntry[] | null>(null);
  const [back, setBack] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tomorrow, setTomorrow] = useState(0);
  const undo = useRef<{ entry: store.QueueEntry; queue: store.QueueEntry[] } | null>(null);
  const shownAt = useRef(Date.now());
  useEffect(() => { store.buildQueue(settings, deckId).then(setQueue); }, [deckId]);
  useEffect(() => { if (queue && !queue.length) store.dueTomorrow().then(setTomorrow); }, [queue?.length]);
  const entry = queue?.[0];

  const rate = async (grade: store.Grade) => {
    if (!entry || !queue) return;
    undo.current = { entry, queue };
    const { next } = await store.rate(entry, grade, Date.now() - shownAt.current);
    const rest = queue.slice(1);
    // "Again" comes back in this session.
    setQueue(grade === store.Rating.Again ? [...rest, { item: entry.item, card: next, isNew: false }] : rest);
    setBack(false);
    shownAt.current = Date.now();
  };
  const doUndo = async () => {
    const u = undo.current;
    if (!u) return;
    await store.undoRate(u.entry.card, u.entry.isNew, u.entry.item.id);
    setQueue(u.queue);
    setBack(false);
    undo.current = null;
  };
  const doSuspend = async () => {
    if (!entry || !queue) return;
    await store.suspend(entry);
    setQueue(queue.slice(1));
    setBack(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target instanceof Element && e.target.closest('input,textarea,select,button'))) return;
      if (e.key === ' ') { e.preventDefault(); setBack(true); }
      else if (back && ['1', '2', '3', '4'].includes(e.key)) rate(GRADES[+e.key - 1][0]);
      else if (e.key.toLowerCase() === 'u') doUndo();
      else if (e.key.toLowerCase() === 's') doSuspend();
      else if (e.key.toLowerCase() === 'e') setEditing(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (!queue) return <p class="muted">Loading…</p>;
  if (!entry)
    return (
      <div class="stack">
        <h2>Done for today.</h2>
        <p>{tomorrow} card{tomorrow === 1 ? '' : 's'} tomorrow.</p>
        {undo.current && <button onClick={doUndo}>Undo last rating</button>}
        <a class="btn" href="#/">Home</a>
      </div>
    );

  const faces = cardFaces(entry.item)!;
  const prev = store.previews(entry.card);
  const deck = deckId ?? '';
  return (
    <div class="stack">
      <p class="muted">{queue.length} left · Space shows the answer · 1–4 rate · E edit · S suspend · U undo</p>
      {editing ? (
        <EditCard item={entry.item} done={async it => {
          setEditing(false);
          if (!it) return;
          await store.saveItem(it);
          setQueue([{ ...entry, item: it }, ...queue.slice(1)]);
        }} />
      ) : (
        <div class="card stack">
          {entry.item.payload.t === 'cloze' && entry.item.payload.context && <p class="muted">{entry.item.payload.context}</p>}
          <p class="big-q"><strong>{faces[0]}</strong></p>
          {back ? (
            <div aria-live="polite" class="stack">
              <p>{faces[1]}</p>
              {deck && <SourceLine item={entry.item} deckId={deck} />}
            </div>
          ) : <button class="primary" onClick={() => setBack(true)}>Show answer</button>}
        </div>
      )}
      {back && !editing && (
        <div class="rate" role="group" aria-label="How well did you know it?">
          {GRADES.map(([g, label, key]) => (
            <button key={label} class={g === store.Rating.Good ? 'primary' : ''} onClick={() => rate(g)} aria-keyshortcuts={key}>
              {label}<small>{store.humanInterval(prev[g])}</small>
            </button>
          ))}
        </div>
      )}
      <div class="row">
        <button onClick={() => setEditing(true)}>Edit</button>
        <button onClick={doSuspend}>Suspend</button>
        <button disabled={!undo.current} onClick={doUndo}>Undo</button>
      </div>
    </div>
  );
}

function EditCard({ item, done }: { item: Item; done: (i: Item | null) => void }) {
  const faces = cardFaces(item)!;
  const [front, setFront] = useState(faces[0]);
  const [backText, setBackText] = useState(faces[1]);
  const save = () => {
    const p = item.payload;
    const payload =
      p.t === 'flash' ? { ...p, front, back: backText }
      : p.t === 'cloze' ? { ...p, text: front, answer: backText }
      : p.t === 'explain' ? { ...p, prompt: front, answer: backText }
      : p.t === 'selfcheck' ? { ...p, question: front }
      : p;
    done({ ...item, payload, status: 'edited', editedAt: Date.now() });
  };
  return (
    <form class="card stack" onSubmit={e => (e.preventDefault(), save())}>
      <label class="check">Front <input type="text" value={front} maxLength={2000} onInput={e => setFront((e.target as HTMLInputElement).value)} /></label>
      <label class="check">Back <input type="text" value={backText} maxLength={2000} onInput={e => setBackText((e.target as HTMLInputElement).value)} /></label>
      <div class="row"><button class="primary" type="submit">Save</button><button type="button" onClick={() => done(null)}>Cancel</button></div>
    </form>
  );
}

