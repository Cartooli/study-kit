import { useEffect, useMemo, useState } from 'preact/hooks';
import { useSettings } from './app.tsx';
import { answerMatches, rng } from './engine/text.ts';
import type { TestRecord } from './io.ts';
import * as store from './store.ts';
import type { Deck, Item, ItemType } from './types.ts';
import { hash, mcqOptions, TYPE_NAMES } from './util.ts';

export const QUIZ_TYPES: ItemType[] = ['mcq', 'tf', 'cloze', 'match', 'sequence'];
const LETTERS = 'ABCDEFGH';

export function SourceLine({ item, deckId }: { item: Item; deckId: string }) {
  return (
    <p class="source">
      From your text: “{item.sourceRef.text}” <a href={`#/deck/${deckId}/read?b=${item.sourceRef.blockId}`}>See source</a>
    </p>
  );
}

// Shuffled-per-seed views of an item, shared by on-screen and printed tests.
const matchDefs = (item: Item, seed: number) => (item.payload.t === 'match' ? rng(seed ^ hash(item.id)).shuffle(item.payload.pairs.map(p => p[1])) : []);
const seqShuffled = (item: Item, seed: number) => {
  if (item.payload.t !== 'sequence') return [];
  const steps = item.payload.steps;
  let out = rng(seed ^ hash(item.id)).shuffle(steps);
  if (out.every((s, i) => s === steps[i])) out = [...steps].reverse();
  return out;
};

export type Answer = { value: unknown; correct: boolean | null };

export function correctText(item: Item): string {
  const p = item.payload;
  switch (p.t) {
    case 'mcq': return p.answer;
    case 'tf': return p.answer ? 'True' : `False — original: “${p.original}”`;
    case 'cloze': return p.answer;
    case 'match': return p.pairs.map(([a, b]) => `${a} → ${b}`).join('; ');
    case 'sequence': return p.steps.map((s, i) => `${i + 1}. ${s}`).join(' ');
    default: return '';
  }
}

export function Question({ item, seed, mode, onAnswer }: { item: Item; seed: number; mode: 'quiz' | 'test'; onAnswer: (a: Answer) => void }) {
  const { settings } = useSettings();
  const p = item.payload;
  const [picked, setPicked] = useState<unknown>(null);
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');
  const [showHint, setShowHint] = useState(settings.hints);
  const options = useMemo(() => mcqOptions(item, seed), [item.id, seed]);
  const defs = useMemo(() => matchDefs(item, seed), [item.id, seed]);
  const [order, setOrder] = useState(() => seqShuffled(item, seed));
  const [matches, setMatches] = useState<string[]>([]);
  useEffect(() => { setPicked(null); setChecked(false); setTyped(''); setOrder(seqShuffled(item, seed)); setMatches([]); }, [item.id, seed]);

  const finish = (value: unknown, correct: boolean | null) => {
    setPicked(value);
    if (mode === 'quiz') setChecked(true);
    onAnswer({ value, correct });
  };
  const feedback = (ok: boolean | null) =>
    mode === 'quiz' && checked && (
      <div aria-live="polite" class="stack">
        {ok === true && <p class="good">Correct.</p>}
        {ok === false && <p class="bad">Not quite. Answer: {correctText(item)}</p>}
      </div>
    );

  switch (p.t) {
    case 'mcq':
      return (
        <div class="stack">
          <p><strong>{p.stem}</strong></p>
          <div class="options" role="group" aria-label="Choices">
            {options.map((o, i) => {
              const cls = mode === 'quiz' && checked ? (o === p.answer ? 'right' : o === picked ? 'wrong' : '') : '';
              return (
                <button key={o} class={cls} aria-pressed={picked === o} disabled={mode === 'quiz' && checked} onClick={() => finish(o, o === p.answer)}>
                  {LETTERS[i]}) {o}
                </button>
              );
            })}
          </div>
          {feedback(picked === p.answer)}
        </div>
      );
    case 'tf':
      return (
        <div class="stack">
          <p><strong>{p.statement}</strong></p>
          <div class="row" role="group" aria-label="True or false">
            {[true, false].map(v => (
              <button key={String(v)} aria-pressed={picked === v} disabled={mode === 'quiz' && checked} onClick={() => finish(v, v === p.answer)}>{v ? 'True' : 'False'}</button>
            ))}
          </div>
          {feedback(picked === p.answer)}
        </div>
      );
    case 'cloze': {
      const ok = checked && answerMatches(typed, p.answer);
      return (
        <div class="stack">
          {p.context && <p class="muted">{p.context}</p>}
          <p><strong>{p.text}</strong></p>
          <div class="row">
            <label class="check">Your answer
              <input type="text" value={typed} disabled={mode === 'quiz' && checked} autoComplete="off" spellcheck={false}
                onInput={e => { const v = (e.target as HTMLInputElement).value; setTyped(v); if (mode === 'test') onAnswer({ value: v, correct: answerMatches(v, p.answer) }); }}
                onKeyDown={e => { if (e.key === 'Enter' && mode === 'quiz' && typed.trim() && !checked) finish(typed, answerMatches(typed, p.answer)); }} />
            </label>
            {mode === 'quiz' && !checked && <button class="primary" disabled={!typed.trim()} onClick={() => finish(typed, answerMatches(typed, p.answer))}>Check</button>}
            <button class="link" onClick={() => setShowHint(!showHint)}>{showHint ? 'Hide hint' : 'Show hint'}</button>
          </div>
          {showHint && <p class="muted">Hint: starts with “{p.hint}”</p>}
          {mode === 'quiz' && checked && (
            <div aria-live="polite">
              {ok ? <p class="good">Correct.</p> : (
                <>
                  <p class="bad">The text says: {p.answer}</p>
                  <div class="row"><button onClick={() => onAnswer({ value: typed, correct: true })}>I was right</button><button onClick={() => onAnswer({ value: typed, correct: false })}>Keep as wrong</button></div>
                </>
              )}
            </div>
          )}
        </div>
      );
    }
    case 'match': {
      const ok = p.pairs.every(([, d], i) => matches[i] === d);
      return (
        <div class="stack">
          <p><strong>Match each term to its meaning.</strong></p>
          {p.pairs.map(([term], i) => (
            <label class="check" key={term}>
              <strong>{term}</strong>
              <select value={matches[i] ?? ''} disabled={mode === 'quiz' && checked} onChange={e => {
                const next = [...matches];
                next[i] = (e.target as HTMLSelectElement).value;
                setMatches(next);
                if (mode === 'test') onAnswer({ value: next, correct: p.pairs.every(([, d], k) => next[k] === d) });
              }}>
                <option value="">Choose…</option>
                {defs.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          ))}
          {mode === 'quiz' && !checked && <button class="primary" onClick={() => finish(matches, ok)}>Check</button>}
          {feedback(ok)}
        </div>
      );
    }
    case 'sequence': {
      const ok = order.every((s, i) => s === p.steps[i]);
      const move = (i: number, d: number) => {
        const next = [...order];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        setOrder(next);
        if (mode === 'test') onAnswer({ value: next, correct: next.every((s, k) => s === p.steps[k]) });
      };
      return (
        <div class="stack">
          <p><strong>{p.prompt}</strong></p>
          <ol class="seq">
            {order.map((s, i) => (
              <li key={s}>
                <span>{s}</span>
                <button aria-label={`Move up: ${s}`} disabled={!i || (mode === 'quiz' && checked)} onClick={() => move(i, -1)}>↑</button>
                <button aria-label={`Move down: ${s}`} disabled={i === order.length - 1 || (mode === 'quiz' && checked)} onClick={() => move(i, 1)}>↓</button>
              </li>
            ))}
          </ol>
          {mode === 'quiz' && !checked && <button class="primary" onClick={() => finish(order, ok)}>Check</button>}
          {feedback(ok)}
        </div>
      );
    }
    default:
      return null;
  }
}

export function QuizView({ deck, items }: { deck: Deck; items: Item[] }) {
  const pool = useMemo(() => rng(deck.settings.seed).shuffle(items.filter(i => QUIZ_TYPES.includes(i.type) && i.status !== 'hidden')), [deck.id, items.length]);
  const [k, setK] = useState(0);
  const [score, setScore] = useState<(boolean | null)[]>([]);
  const [answered, setAnswered] = useState(false);
  if (!pool.length) return <p>No quiz questions in this set. Try Flip or Practice test instead.</p>;
  if (k >= pool.length) {
    const right = score.filter(Boolean).length;
    return (
      <div class="stack">
        <h2>Quiz done</h2>
        <p class="big">{right} / {pool.length}</p>
        <button class="primary" onClick={() => { setK(0); setScore([]); setAnswered(false); }}>Try again</button>
      </div>
    );
  }
  const item = pool[k];
  return (
    <div class="stack">
      <p class="muted">Question {k + 1} of {pool.length} · {TYPE_NAMES[item.type]} · {score.filter(Boolean).length} right so far</p>
      <div class="card stack">
        <Question key={item.id} item={item} seed={deck.settings.seed} mode="quiz" onAnswer={a => { const s = [...score]; s[k] = a.correct; setScore(s); setAnswered(true); }} />
        {answered && <SourceLine item={item} deckId={deck.id} />}
      </div>
      <button class="primary" disabled={!answered} onClick={() => { setK(k + 1); setAnswered(false); }}>Next</button>
    </div>
  );
}

// --- Practice tests (§8.7) ----------------------------------------------------

type TestConfig = { types: ItemType[]; count: number; minutes: number; layout: 'one' | 'all'; version: 'A' | 'B' };

export function TestView({ deck, items }: { deck: Deck; items: Item[] }) {
  const available = items.filter(i => QUIZ_TYPES.includes(i.type) && i.status !== 'hidden');
  const [cfg, setCfg] = useState<TestConfig>({ types: QUIZ_TYPES.filter(t => available.some(i => i.type === t)), count: 20, minutes: 0, layout: 'all', version: 'A' });
  const [phase, setPhase] = useState<'build' | 'take' | 'done' | 'print'>('build');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [at, setAt] = useState(0);
  const [started, setStarted] = useState(0);
  const [left, setLeft] = useState(0);
  const seed = deck.settings.seed * 2 + (cfg.version === 'B' ? 1 : 0);
  const chosen = useMemo(() => rng(seed).shuffle(available.filter(i => cfg.types.includes(i.type))).slice(0, cfg.count), [seed, cfg.types.join(), cfg.count, available.length]);

  useEffect(() => {
    if (phase !== 'take' || !cfg.minutes) return;
    const t = setInterval(() => {
      const remaining = cfg.minutes * 60 - Math.floor((Date.now() - started) / 1000);
      setLeft(remaining);
      if (remaining <= 0) finish();
    }, 1000);
    return () => clearInterval(t);
  }, [phase, started]);
  useEffect(() => {
    if (phase !== 'print') return;
    const back = () => setPhase('build');
    addEventListener('afterprint', back, { once: true });
    setTimeout(() => print(), 50);
    return () => removeEventListener('afterprint', back);
  }, [phase]);

  const finish = async () => {
    setPhase('done');
    const score = answers.filter(a => a?.correct).length;
    const id = `${deck.id}-tests`;
    const rec = (await store.get<TestRecord>('tests', id)) ?? { id, deckId: deck.id, seed, config: {}, attempts: [] };
    rec.seed = seed;
    rec.config = { count: cfg.count, minutes: cfg.minutes, layout: cfg.layout, version: cfg.version, types: cfg.types.join(',') };
    rec.attempts.push({ startedAt: started, finishedAt: Date.now(), answers: [], score });
    await store.put('tests', rec);
  };
  const setAns = (i: number) => (a: Answer) => setAnswers(prev => { const n = [...prev]; n[i] = a; return n; });

  if (!available.length) return <p>No test questions in this set. Make the set again with multiple choice, true/false or fill-in-the-blank turned on.</p>;

  if (phase === 'print') return <PrintTest deck={deck} items={chosen} seed={seed} version={cfg.version} />;

  if (phase === 'take')
    return (
      <div class="stack">
        <p class="muted">Practice test · Version {cfg.version}{cfg.minutes ? ` · ${Math.floor(left / 60)}:${String(Math.max(0, left % 60)).padStart(2, '0')} left` : ''}</p>
        {(cfg.layout === 'all' ? chosen : [chosen[at]]).map(item => {
          const i = chosen.indexOf(item);
          return (
            <div class="card" key={item.id}>
              <p class="muted">{i + 1}.</p>
              <Question item={item} seed={seed} mode="test" onAnswer={setAns(i)} />
            </div>
          );
        })}
        <div class="row">
          {cfg.layout === 'one' && at > 0 && <button onClick={() => setAt(at - 1)}>Back</button>}
          {cfg.layout === 'one' && at < chosen.length - 1 ? <button class="primary" onClick={() => setAt(at + 1)}>Next</button> : <button class="primary" onClick={finish}>Finish test</button>}
        </div>
      </div>
    );

  if (phase === 'done') {
    const score = answers.filter(a => a?.correct).length;
    return (
      <div class="stack">
        <h2>Your score</h2>
        <p class="big">{score} / {chosen.length}</p>
        {chosen.map((item, i) => answers[i]?.correct ? null : (
          <div class="card" key={item.id}>
            <p><strong>{i + 1}.</strong> {questionText(item)}</p>
            <p class="bad">Answer: {correctText(item)}</p>
            <SourceLine item={item} deckId={deck.id} />
          </div>
        ))}
        <button class="primary" onClick={() => { setAnswers([]); setPhase('build'); }}>Back to test builder</button>
      </div>
    );
  }

  const toggle = (t: ItemType) => setCfg(c => ({ ...c, types: c.types.includes(t) ? c.types.filter(x => x !== t) : [...c.types, t] }));
  return (
    <div class="stack">
      <h2>Practice test</h2>
      <fieldset>
        <legend>Question types</legend>
        {QUIZ_TYPES.map(t => {
          const n = available.filter(i => i.type === t).length;
          return <label class="check" key={t}><input type="checkbox" disabled={!n} checked={cfg.types.includes(t)} onChange={() => toggle(t)} /> {TYPE_NAMES[t]} ({n})</label>;
        })}
      </fieldset>
      <div class="row">
        <label class="check">Questions <select value={cfg.count} onChange={e => setCfg({ ...cfg, count: +(e.target as HTMLSelectElement).value })}>{[10, 20, 40, 100].map(n => <option key={n} value={n}>{n === 100 ? 'All' : n}</option>)}</select></label>
        <label class="check">Timer <select value={cfg.minutes} onChange={e => setCfg({ ...cfg, minutes: +(e.target as HTMLSelectElement).value })}>{[0, 10, 20, 30, 45].map(n => <option key={n} value={n}>{n ? `${n} min` : 'None'}</option>)}</select></label>
        <label class="check">Show <select value={cfg.layout} onChange={e => setCfg({ ...cfg, layout: (e.target as HTMLSelectElement).value as TestConfig['layout'] })}><option value="all">All on one page</option><option value="one">One at a time</option></select></label>
        <label class="check">Version <select value={cfg.version} onChange={e => setCfg({ ...cfg, version: (e.target as HTMLSelectElement).value as TestConfig['version'] })}><option>A</option><option>B</option></select></label>
      </div>
      <p class="muted">{chosen.length} questions. Version B reshuffles the order and answer choices.</p>
      <div class="row">
        <button class="primary" disabled={!chosen.length} onClick={() => { setAnswers([]); setAt(0); setStarted(Date.now()); setLeft(cfg.minutes * 60); setPhase('take'); }}>Start test</button>
        <button disabled={!chosen.length} onClick={() => setPhase('print')}>Print test and answer key</button>
      </div>
    </div>
  );
}

function questionText(item: Item): string {
  const p = item.payload;
  return p.t === 'mcq' ? p.stem : p.t === 'tf' ? p.statement : p.t === 'cloze' ? p.text : p.t === 'match' ? 'Match each term to its meaning.' : p.t === 'sequence' ? p.prompt : '';
}

function PrintTest({ deck, items, seed, version }: { deck: Deck; items: Item[]; seed: number; version: string }) {
  return (
    <div class="print-sheet">
      <p class="no-print muted">Printing… If the print window didn't open, use your browser's Print command.</p>
      <h1>{deck.title} — Practice test, Version {version}</h1>
      <div class="nameline"><span>Name</span><span>Date</span></div>
      <ol>
        {items.map(item => {
          const p = item.payload;
          return (
            <li key={item.id}>
              <p>{questionText(item)}</p>
              {p.t === 'mcq' && <ol type="A">{mcqOptions(item, seed).map(o => <li key={o}>{o}</li>)}</ol>}
              {p.t === 'tf' && <p>True / False</p>}
              {p.t === 'match' && (
                <div class="row">
                  <ol>{p.pairs.map(([t]) => <li key={t}>{t} ____</li>)}</ol>
                  <ol type="A">{matchDefs(item, seed).map(d => <li key={d}>{d}</li>)}</ol>
                </div>
              )}
              {p.t === 'sequence' && <ul class="plain">{seqShuffled(item, seed).map(s => <li key={s}>____ {s}</li>)}</ul>}
            </li>
          );
        })}
      </ol>
      <div class="page-break">
        <h2>Answer key — Version {version}</h2>
        <ol>
          {items.map(item => {
            const p = item.payload;
            const ans = p.t === 'mcq' ? `${LETTERS[mcqOptions(item, seed).indexOf(p.answer)]}) ${p.answer}`
              : p.t === 'match' ? p.pairs.map(([t, d], i) => `${i + 1}–${LETTERS[matchDefs(item, seed).indexOf(d)]} (${t})`).join(', ')
              : p.t === 'sequence' ? seqShuffled(item, seed).map(s => p.steps.indexOf(s) + 1).join(', ') + ' (numbers in the order printed)'
              : correctText(item);
            return <li key={item.id}>{ans}</li>;
          })}
        </ol>
      </div>
    </div>
  );
}
