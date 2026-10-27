import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { DeckView } from './deck.tsx';
import { dailyIcs, IMPORT_MAX_BYTES } from './io.ts';
import { LoadView } from './load.tsx';
import { ReviewView } from './review.tsx';
import * as store from './store.ts';
import type { Deck, Source } from './types.ts';
import { download } from './util.ts';

export const SettingsCtx = createContext<{ settings: store.Settings; set: <K extends keyof store.Settings>(k: K, v: store.Settings[K]) => void }>(null!);
export const useSettings = () => useContext(SettingsCtx);

declare const __APP_VERSION__: string;
export const VERSION = __APP_VERSION__;
export const SINGLE = import.meta.env.MODE === 'single';

export type Route = { parts: string[]; q: URLSearchParams };
const parseHash = (): Route => {
  const [path, q = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(q) };
};
export const go = (path: string) => (location.hash = '#/' + path);

// Install prompt + service-worker update state are set from main.tsx.
export const shell = { installEvent: null as null | { prompt(): void }, updateReady: false, applyUpdate: () => {} };

export function App({ initial }: { initial: store.Settings }) {
  const [route, setRoute] = useState(parseHash);
  const [settings, setSettings] = useState(initial);
  const [, bump] = useState(0);
  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      document.getElementById('main')?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    };
    const onShell = () => bump(n => n + 1);
    addEventListener('hashchange', onHash);
    addEventListener('sk-shell', onShell);
    return () => {
      removeEventListener('hashchange', onHash);
      removeEventListener('sk-shell', onShell);
    };
  }, []);
  const set = <K extends keyof store.Settings>(k: K, v: store.Settings[K]) => {
    const next = { ...settings, [k]: v };
    setSettings(next);
    store.applySettings(next);
    store.saveSetting(k, v);
  };
  const [p0, p1, p2] = route.parts;
  let view;
  if (p0 === 'new') view = <LoadView />;
  else if (p0 === 'deck' && p1) view = <DeckView id={p1} tab={p2 ?? 'check'} q={route.q} />;
  else if (p0 === 'review') view = <ReviewView />;
  else if (p0 === 'settings') view = <SettingsView />;
  else view = <Home />;
  const here = (p: string) => (p0 ?? '') === p ? 'page' : undefined;
  return (
    <SettingsCtx.Provider value={{ settings, set }}>
      <a class="skip" href="#main" onClick={e => (e.preventDefault(), document.getElementById('main')?.focus())}>Skip to content</a>
      <header class="top">
        <a class="brand" href="#/">Study Kit</a>
        <nav aria-label="Main">
          <a class="btn" href="#/" aria-current={here('')}>Home</a>
          <a class="btn" href="#/new" aria-current={here('new')}>New</a>
          <a class="btn" href="#/review" aria-current={here('review')}>Review</a>
          <a class="btn" href="#/settings" aria-current={here('settings')}>Settings</a>
        </nav>
      </header>
      {!store.persistent && (
        <div class="banner" role="status">
          <span>This browser won't remember your cards. Use <strong>Save progress file</strong> before closing.</span>
          <button onClick={async () => download('study-kit-progress.studykit.json', await store.exportAll(), 'application/json')}>Save progress file</button>
        </div>
      )}
      {shell.updateReady && (
        <div class="banner" role="status">
          <span>Update ready — reload when you're done.</span>
          <button onClick={() => shell.applyUpdate()}>Reload now</button>
        </div>
      )}
      <main id="main" tabIndex={-1}>{view}</main>
      <footer>
        Study Kit {VERSION}{SINGLE ? ' (offline file)' : ''} · Free · Built by rules, not AI · Your files never leave this device.
      </footer>
    </SettingsCtx.Provider>
  );
}

function Home() {
  const { settings } = useSettings();
  const [decks, setDecks] = useState<{ deck: Deck; source?: Source; due: number }[] | null>(null);
  const [dueTotal, setDueTotal] = useState(0);
  const [iosTip, setIosTip] = useState(false);
  useEffect(() => {
    (async () => {
      const ds = (await store.all<Deck>('decks')).sort((a, b) => b.updatedAt - a.updatedAt);
      const rows = await Promise.all(ds.map(async deck => ({ deck, source: await store.get<Source>('sources', deck.sourceIds[0]), due: (await store.buildQueue(settings, deck.id)).length })));
      setDecks(rows);
      setDueTotal((await store.buildQueue(settings)).length);
    })();
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const standalone = (navigator as { standalone?: boolean }).standalone || matchMedia('(display-mode: standalone)').matches;
    try {
      if (ios && !standalone && !SINGLE && !localStorage.getItem('studykit:iosTip')) setIosTip(true);
    } catch { /* storage blocked: skip the tip */ }
  }, []);
  const dismissTip = () => {
    setIosTip(false);
    try { localStorage.setItem('studykit:iosTip', '1'); } catch { /* storage blocked */ }
  };
  return (
    <div class="stack">
      <h1>Study Kit</h1>
      <p>Turn a handout, notes, an essay or a PDF into flashcards, quizzes and practice tests. Everything stays on this device.</p>
      <div class="row">
        <a class="btn primary" href="#/new">Make a study set</a>
        {shell.installEvent && <button onClick={() => shell.installEvent?.prompt()}>Install app</button>}
      </div>
      {iosTip && (
        <div class="card row">
          <span>To use Study Kit offline on this iPhone or iPad, tap Share, then <strong>Add to Home Screen</strong>.</span>
          <button onClick={dismissTip}>Got it</button>
        </div>
      )}
      <div class="card row">
        <span class="big" aria-hidden="true">{dueTotal}</span>
        <span>{dueTotal === 1 ? 'card' : 'cards'} due today</span>
        {dueTotal > 0 && <a class="btn primary" href="#/review">Review now</a>}
      </div>
      <h2>Your study sets</h2>
      {decks === null ? <p class="muted">Loading…</p> : !decks.length ? (
        <p class="muted">No study sets yet. Make one from a file or pasted text.</p>
      ) : (
        <ul class="cards plain" role="list">
          {decks.map(({ deck, source, due }) => (
            <li class="card" key={deck.id}>
              <a href={`#/deck/${deck.id}/check`}><strong>{deck.title}</strong></a>
              <p class="muted">
                {source ? `${TYPE_LABEL[source.docType]} · ${source.stats.words.toLocaleString()} words · ` : ''}
                {deck.itemIds.length} items · {due} due
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const TYPE_LABEL: Record<Source['docType'], string> = { lesson: 'Lesson plan', reading: 'Reading', essay: 'Essay', notes: 'Notes', homework: 'Homework / worksheet', math: 'Math-heavy' };

function SettingsView() {
  const { settings, set } = useSettings();
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [msg, setMsg] = useState('');
  const [time, setTime] = useState('18:00');
  useEffect(() => { store.storageEstimate().then(setUsage); }, []);
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  const onImport = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (f.size > IMPORT_MAX_BYTES) return setMsg('That file is over 25 MB.');
    try {
      const n = await store.importText(await f.text());
      setMsg(`Opened ${n} study set${n === 1 ? '' : 's'}.`);
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  const wipe = async () => {
    if (!confirm('Delete everything in Study Kit? This removes every study set, card and review history on this device.')) return;
    await store.wipeEverything();
    location.hash = '#/';
    location.reload();
  };
  return (
    <div class="stack">
      <h1>Settings</h1>
      <fieldset>
        <legend>Reading</legend>
        <label class="check">Theme
          <select value={settings.theme} onChange={e => set('theme', (e.target as HTMLSelectElement).value as store.Settings['theme'])}>
            <option value="system">Match device</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
        <label class="check">Text size {settings.textSize}%
          <input type="range" min={100} max={200} step={10} value={settings.textSize} onInput={e => set('textSize', +(e.target as HTMLInputElement).value)} />
        </label>
        <label class="check"><input type="checkbox" checked={settings.spacing} onChange={e => set('spacing', (e.target as HTMLInputElement).checked)} /> Extra letter and line spacing</label>
      </fieldset>
      <fieldset>
        <legend>Review</legend>
        <label class="check">New cards per day
          <input type="number" min={0} max={100} value={settings.newPerDay} onChange={e => set('newPerDay', Math.max(0, Math.min(100, +(e.target as HTMLInputElement).value || 0)))} />
        </label>
        <label class="check"><input type="checkbox" checked={settings.hints} onChange={e => set('hints', (e.target as HTMLInputElement).checked)} /> Show fill-in-the-blank hints</label>
        <div class="row">
          <label class="check">Daily reminder at <input type="time" value={time} onInput={e => setTime((e.target as HTMLInputElement).value)} /></label>
          <button onClick={() => { const [h, m] = time.split(':').map(Number); download('study-kit-reminder.ics', dailyIcs(h || 0, m || 0, store.uid()), 'text/calendar'); }}>Add to my calendar</button>
        </div>
        <p class="muted">Downloads a calendar file. Study Kit never sends notifications.</p>
      </fieldset>
      <fieldset>
        <legend>Your data</legend>
        <p>{store.persistent ? 'Saved in this browser only.' : "This browser isn't saving your cards. Save a progress file before closing."}{usage && ` Using ${mb(usage.usage)} of ${mb(usage.quota)}.`}</p>
        {usage && usage.usage / usage.quota > 0.8 && <p class="error">Storage is over 80% full. Export your study sets and delete ones you're done with.</p>}
        <div class="row">
          <button onClick={async () => download('study-kit-progress.studykit.json', await store.exportAll(), 'application/json')}>Save progress file</button>
          <label class="btn">Open progress file<input type="file" accept=".json,application/json" class="skip" onChange={onImport} /></label>
        </div>
        <p role="status">{msg}</p>
        <button class="danger" onClick={wipe}>Delete everything in Study Kit</button>
      </fieldset>
      <fieldset>
        <legend>About</legend>
        <p>Study Kit {VERSION}. Free, offline, built by rules, not AI. Nothing you open is uploaded.</p>
        <p>Check for updates at studyspine.org/study-kit.</p>
        <p>Free for students, families, teachers and schools (PolyForm Noncommercial License 1.0.0). Commercial use needs a license from MLN Learning LLC.{!SINGLE && <> <a href="/third-party-notices.txt">Third-party notices</a>.</>}</p>
      </fieldset>
    </div>
  );
}
