// Caches the app shell so it opens instantly (and offline) in Japan. API calls are never cached.
const CACHE = 'kaimono-v41';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'prompt.js', 'firebase-config.js', 'tour/sample-tag.svg', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'fonts/Geist-Variable.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first for the app's own files so updates land straight away; cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    // no-cache: revalidate with GitHub Pages instead of trusting its 10-minute HTTP cache.
    // (A navigation Request can't take init options, so rebuild it from the URL.)
    fetch(new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

// "Your scan is ready" (Web Push from the backend), so the app can be closed while a scan runs.
self.addEventListener('push', (e) => {
  let msg = {};
  try {
    msg = e.data ? e.data.json() : {};
  } catch {
    msg = { body: e.data?.text() };
  }
  e.waitUntil(self.registration.showNotification(msg.title || 'Kaimono', {
    body: msg.body || 'Your scan is ready.',
    tag: msg.tag || 'scan',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: msg.url || '#/' },
  }));
});

// Tapping it opens the scan: in the app if it's open, otherwise by launching it.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '#/', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) return win.focus().then((w) => w.navigate(url));
    return self.clients.openWindow(url);
  }));
});
