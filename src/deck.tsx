import { useEffect, useState } from 'preact/hooks';
import { go, TYPE_LABEL } from './app.tsx';
import type { GenResult } from './engine/generate.ts';
import { cardFaces, deckDelimited } from './io.ts';
import { QuizView, SourceLine, TestView } from './questions.tsx';
import { ReviewView } from './review.tsx';
import * as store from './store.ts';
import { ITEM_TYPES, type Deck, type Item, type Payload, type Source } from './types.ts';
import { download, safeName, TYPE_NAMES } from './util.ts';
import { runWorker } from './worker-client.ts';

type Data = { deck: Deck; sources: Source[]; items: Item[] };
const TABS = [['check', 'Check items'], ['flip', 'Flip'], ['quiz', 'Quiz'], ['test', 'Practice test'], ['review', 'Review'], ['read', 'Read it again'], ['export', 'Export']] as const;

export function DeckView({ id, tab, q }: { id: string; tab: string; q: URLSearchParams }) {
  const [data, setData] = useState<Data | null | undefined>(undefined);
  const reload = () => store.deckData(id).then(setData);
  useEffect(() => { reload(); }, [id]);
  if (data === undefined) return <p class="muted">Loading…</p>;
  if (data === null) return <p>That study set isn't here. <a href="#/">Go home</a></p>;
  const { deck } = data;
  return (
    <div>
      <h1>{deck.title}</h1>
      <nav class="tabs" aria-label="Study set">
        {TABS.map(([t, label]) => <a key={t} href={`#/deck/${id}/${t}`} aria-current={tab === t ? 'page' : undefined}>{label}</a>)}
      </nav>
      {tab === 'check' && <CheckView data={data} reload={reload} />}
      {tab === 'flip' && <FlipView data={data} />}
      {tab === 'quiz' && <QuizView deck={deck} items={data.items} />}
      {tab === 'test' && <TestView deck={deck} items={data.items} />}
      {tab === 'review' && <ReviewView deckId={id} />}
      {tab === 'read' && <ReadView data={data} highlight={q.get('b')} reload={reload} />}
      {tab === 'export' && <ExportView data={data} />}
    </div>
  );
}

// --- Review set (§5.4) -------------------------------------------------------

function CheckView({ data, reload }: { data: Data; reload: () => void }) {
  const { deck, items, sources } = data;
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  let notes: { notices: string[]; skipped: Record<string, string> } | null = null;
  try { notes = JSON.parse(sessionStorage.getItem(`studykit:notes:${deck.id}`) ?? 'null'); } catch { /* optional */ }
  const hidden = items.filter(i => i.status === 'hidden');
  const setStatus = async (item: Item, status: Item['status']) => {
    await store.saveItem({ ...item, status });
    reload();
  };
  const regenerate = async () => {
    const src = sources[0];
    if (!src) return;
    setBusy(true);
    try {
      const seed = deck.settings.seed + 1;
      const res = await runWorker<GenResult>({ op: 'generate', blocks: src.blocks, settings: deck.settings, seed, sourceId: src.id, idPrefix: store.uid().slice(0, 8) + '-' }).promise;
      const kept = items.filter(i => i.status === 'edited');
      const now = Date.now();
      const fresh = res.items.map(i => ({ ...i, createdAt: now }));
      const old = items.filter(i => i.status !== 'edited').map(i => i.id);
      await store.delMany('items', old);
      await store.delMany('srs', old);
      await store.putMany('items', fresh);
      await store.put('sources', { ...src, restate: res.restate });
      await store.put('decks', { ...deck, settings: { ...deck.settings, seed }, itemIds: [...kept.map(i => i.id), ...fresh.map(i => i.id)], updatedAt: now });
      reload();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!confirm(`Delete “${deck.title}” and its review history?`)) return;
    await store.deleteDeck(deck);
    go('');
  };
  const src = sources[0];
  return (
    <div class="stack">
      {src && <p class="muted">{TYPE_LABEL[src.docType]} · {src.stats.words.toLocaleString()} words · {items.filter(i => i.status !== 'hidden').length} items. Every item is made from your text, so check them before you study.</p>}
      {notes?.notices.map(n => <p class="banner" key={n}>{n}</p>)}
      <div class="row">
        <a class="btn primary" href={`#/deck/${deck.id}/flip`}>Looks good — start studying</a>
        <button disabled={busy} onClick={regenerate}>{busy ? 'Making…' : 'Make a new version'}</button>
        <button class="danger" onClick={del}>Delete set</button>
      </div>
      {ITEM_TYPES.map(type => {
        const list = items.filter(i => i.type === type && (showHidden || i.status !== 'hidden'));
        const why = notes?.skipped[type];
        if (!list.length) return why ? <p class="muted" key={type}><strong>{TYPE_NAMES[type]}:</strong> skipped — {why}</p> : null;
        return (
          <section key={type}>
            <h2>{TYPE_NAMES[type]} ({list.length})</h2>
            <ul class="cards plain" role="list">
              {list.map(item => (
                <li class="card" key={item.id}>
                  {editing === item.id ? (
                    <Editor item={item} done={async next => { if (next) await store.saveItem(next); setEditing(null); reload(); }} />
                  ) : (
                    <>
                      <ItemSummary item={item} />
                      {item.status === 'hidden' && <p class="tag">Lower confidence</p>}
                      <SourceLine item={item} deckId={deck.id} />
                      <div class="row">
                        {item.status === 'hidden' && <button onClick={() => setStatus(item, 'active')}>Keep</button>}
                        <button onClick={() => setEditing(item.id)}>Edit</button>
                        <button onClick={() => setStatus(item, 'deleted')}>Delete</button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {!!hidden.length && <button onClick={() => setShowHidden(!showHidden)}>{showHidden ? 'Hide' : 'Show'} {hidden.length} lower-confidence item{hidden.length === 1 ? '' : 's'}</button>}
    </div>
  );
}

function ItemSummary({ item }: { item: Item }) {
  const p = item.payload;
  if (p.t === 'match') return <ul class="plain">{p.pairs.map(([a, b]) => <li key={a}><strong>{a}</strong> — {b}</li>)}</ul>;
  if (p.t === 'sequence') return <><p><strong>{p.prompt}</strong></p><ol class="plain">{p.steps.map(s => <li key={s}>{s}</li>)}</ol></>;
  if (p.t === 'mcq') return <><p><strong>{p.stem}</strong></p><p>Answer: {p.answer} <span class="muted">· other choices from: {p.pool.join(', ')}</span></p></>;
  const f = cardFaces(item)!;
  return <><p><strong>{f[0]}</strong></p><p>{f[1]}</p></>;
}

// Generic editor: every text field of the payload becomes an input.
function Editor({ item, done }: { item: Item; done: (next: Item | null) => void }) {
  const [p, setP] = useState<Payload>(item.payload);
  const fields = Object.entries(p).filter(([k]) => k !== 't');
  const set = (k: string, v: unknown) => setP({ ...p, [k]: v } as Payload);
  return (
    <form class="stack" onSubmit={e => { e.preventDefault(); done({ ...item, payload: p, status: 'edited', editedAt: Date.now() }); }}>
      {fields.map(([k, v]) => {
        if (typeof v === 'string') return <label class="check" key={k}>{k} <input type="text" value={v} maxLength={2000} onInput={e => set(k, (e.target as HTMLInputElement).value)} /></label>;
        if (typeof v === 'boolean') return <label class="check" key={k}><input type="checkbox" checked={v} onChange={e => set(k, (e.target as HTMLInputElement).checked)} /> {k === 'answer' ? 'Statement is true' : k}</label>;
        if (Array.isArray(v))
          return (
            <fieldset key={k}>
              <legend>{k}</legend>
              {v.map((x, i) =>
                Array.isArray(x) ? (
                  <div class="row" key={i}>
                    {x.map((y, j) => <input type="text" key={j} value={y} aria-label={`${k} ${i + 1} part ${j + 1}`} onInput={e => { const n = v.map(r => [...(r as string[])]); n[i][j] = (e.target as HTMLInputElement).value; set(k, n); }} />)}
                  </div>
                ) : (
                  <input type="text" key={i} value={x as string} aria-label={`${k} ${i + 1}`} onInput={e => { const n = [...(v as string[])]; n[i] = (e.target as HTMLInputElement).value; set(k, n); }} />
                ),
              )}
            </fieldset>
          );
        return null;
      })}
      <div class="row"><button class="primary" type="submit">Save</button><button type="button" onClick={() => done(null)}>Cancel</button></div>
    </form>
  );
}

// --- Flip (§5.5) -------------------------------------------------------------

function FlipView({ data }: { data: Data }) {
  const cards = data.items.filter(i => i.status !== 'hidden' && cardFaces(i));
  const [k, setK] = useState(0);
  const [back, setBack] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input,textarea,select,button')) return;
      if (e.key === ' ') { e.preventDefault(); setBack(b => !b); }
      if (e.key === 'ArrowRight') { setK(x => Math.min(cards.length - 1, x + 1)); setBack(false); }
      if (e.key === 'ArrowLeft') { setK(x => Math.max(0, x - 1)); setBack(false); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [cards.length]);
  if (!cards.length) return <p>No cards to flip yet.</p>;
  const item = cards[Math.min(k, cards.length - 1)];
  const [front, answer] = cardFaces(item)!;
  return (
    <div class="stack">
      <p class="muted">Card {k + 1} of {cards.length} · Space to flip · arrow keys to move</p>
      <button class={`card flip${back ? ' back' : ''}`} onClick={() => setBack(!back)} aria-live="polite" aria-label={back ? `Answer: ${answer}` : `Question: ${front}. Activate to flip.`}>
        {item.payload.t === 'cloze' && item.payload.context && !back && <span class="muted">{item.payload.context}</span>}
        <span>{back ? answer : front}</span>
      </button>
      {back && <SourceLine item={item} deckId={data.deck.id} />}
      <div class="row">
        <button disabled={!k} onClick={() => { setK(k - 1); setBack(false); }}>Previous</button>
        <button class="primary" disabled={k >= cards.length - 1} onClick={() => { setK(k + 1); setBack(false); }}>Next</button>
      </div>
    </div>
  );
}

// --- Read it again (§8.8) ----------------------------------------------------

function ReadView({ data, highlight, reload }: { data: Data; highlight: string | null; reload: () => void }) {
  const src = data.sources[0];
  const [err, setErr] = useState('');
  useEffect(() => {
    if (src && !src.restate)
      runWorker<GenResult>({ op: 'generate', blocks: src.blocks, settings: data.deck.settings, seed: data.deck.settings.seed, sourceId: src.id, idPrefix: 'tmp-' })
        .promise.then(r => store.put('sources', { ...src, restate: r.restate })).then(reload, e => setErr((e as Error).message));
  }, [src?.id]);
  useEffect(() => {
    if (highlight) document.getElementById(`blk-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [highlight, src?.restate]);
  if (!src) return null;
  const r = src.restate;
  return (
    <div class="stack">
      <div class="row no-print"><button onClick={() => print()}>Print</button></div>
      {err && <p class="error">{err}</p>}
      {!r ? <p class="muted">Getting this ready…</p> : (
        <>
          <section>
            <h2>Key points</h2>
            <p class="muted">The most important sentences from your text</p>
            <ul>{r.keyPoints.map(k => <li key={k.text}>{k.text}</li>)}</ul>
          </section>
          {!!r.outline.length && (
            <section>
              <h2>Outline</h2>
              <ul>{r.outline.map(o => <li key={o.title}><strong>{o.title}</strong>{o.top && <> — {o.top}</>}</li>)}</ul>
            </section>
          )}
          {!!r.glossary.length && (
            <section>
              <h2>Glossary from your text</h2>
              <dl>{r.glossary.map(g => <div key={g.term}><dt><strong>{g.term}</strong></dt><dd>{g.def}</dd></div>)}</dl>
            </section>
          )}
          <section>
            <h2>Simplified text</h2>
            <p class="muted">Simplified by rules — check it against the original. Reading level: grade {r.simplified.gradeBefore} → {r.simplified.gradeAfter} (Flesch–Kincaid).</p>
            {r.simplified.text.split('\n\n').map((para, i) => <p key={i}>{para}</p>)}
          </section>
          {!!r.sayItBack.length && (
            <section>
              <h2>Say it in your own words</h2>
              <ol>{r.sayItBack.map(s => <li key={s}>{s}</li>)}</ol>
            </section>
          )}
        </>
      )}
      <section>
        <h2>Original text</h2>
        {src.blocks.map(b => {
          const cls = b.id === highlight ? 'hl' : undefined;
          const props = { id: `blk-${b.id}`, class: cls, key: b.id };
          if (b.kind === 'heading') return <h3 {...props}>{b.text}</h3>;
          return <p {...props}>{b.kind === 'listItem' ? '• ' : ''}{b.text}</p>;
        })}
      </section>
    </div>
  );
}

// --- Export (§5.7) -----------------------------------------------------------

function ExportView({ data }: { data: Data }) {
  const { deck, items } = data;
  const live = items.filter(i => i.status !== 'hidden');
  const name = safeName(deck.title);
  return (
    <div class="stack">
      <h2>Take it with you</h2>
      <div class="card stack">
        <p><strong>Study Kit file</strong> — opens in Study Kit on another device, with your review progress.</p>
        <button onClick={async () => download(`${name}.studykit.json`, await store.exportAll(deck.id), 'application/json')}>Download .studykit.json</button>
      </div>
      <div class="card stack">
        <p><strong>Cards for Anki and other card apps</strong> — front, back, tags, source.</p>
        <div class="row">
          <button onClick={() => download(`${name}.tsv`, deckDelimited(live, '\t'), 'text/tab-separated-values')}>Download TSV</button>
          <button onClick={() => download(`${name}.csv`, deckDelimited(live, ','), 'text/csv')}>Download CSV</button>
        </div>
      </div>
      <div class="card stack">
        <p><strong>Print</strong> — use Practice test for a test and answer key, or Read it again for a glossary and key points. Choose “Save as PDF” in the print window to keep a copy.</p>
        <div class="row">
          <a class="btn" href={`#/deck/${deck.id}/test`}>Practice test</a>
          <a class="btn" href={`#/deck/${deck.id}/read`}>Read it again</a>
        </div>
      </div>
    </div>
  );
}
