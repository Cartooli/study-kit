// Hand-written service worker (§11). Build fills in VERSION and FILES.
const VERSION = '__VERSION__';
const CACHE = `studykit-${VERSION}`;
const FILES = [/*__FILES__*/];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('studykit-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page asks for this only when the user chooses to reload.
self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

// Cache-first for same-origin GET. Nothing cross-origin is ever requested or cached.
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    // ignoreVary: module scripts send Origin, and servers often answer with "Vary: Origin".
    caches.open(CACHE).then(async c => (await c.match(req, { ignoreSearch: true, ignoreVary: true })) ?? (req.mode === 'navigate' ? await c.match('/index.html') : undefined) ?? fetch(req)),
  );
});
