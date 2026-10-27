// Kill switch: deploy this file as /sw.js only if a bad service worker ever ships.
// It clears every Study Kit cache, unregisters itself and reloads open tabs from the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) await caches.delete(k);
      await self.registration.unregister();
      for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
    })(),
  );
});
