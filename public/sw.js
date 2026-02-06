self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('finanzas-v1').then((cache) =>
    cache.addAll(['/', '/index.html', '/styles.css', '/app.js', '/config.js', '/manifest.json', '/icon.svg'])
  ));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => { self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
