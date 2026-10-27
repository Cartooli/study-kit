import { render } from 'preact';
import { App, shell, SINGLE } from './app.tsx';
import { scriptURL } from './policy.ts';
import * as store from './store.ts';
import './styles.css';

const ping = () => dispatchEvent(new Event('sk-shell'));

async function registerServiceWorker() {
  if (SINGLE || !import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.register(scriptURL('/sw.js'), { scope: '/' });
  const waiting = (w: ServiceWorker | null) => {
    if (!w || !navigator.serviceWorker.controller) return;
    shell.updateReady = true;
    // Never auto-reload mid-session: the user chooses when.
    shell.applyUpdate = () => {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      w.postMessage('skip-waiting');
    };
    ping();
  };
  // An update may already be installing or waiting by the time register() resolves.
  const track = (w: ServiceWorker | null) => {
    if (w?.state === 'installed') waiting(w);
    else w?.addEventListener('statechange', () => w.state === 'installed' && waiting(w));
  };
  track(reg.waiting);
  track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));
  if (navigator.onLine) reg.update().catch(() => {});
}

addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  shell.installEvent = e as Event & { prompt(): void };
  ping();
});

(async () => {
  await store.initDb();
  const settings = await store.loadSettings();
  store.applySettings(settings);
  render(<App initial={settings} />, document.getElementById('app')!);
  registerServiceWorker().catch(() => {});
})();
