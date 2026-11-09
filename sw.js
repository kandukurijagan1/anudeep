// AKB Billing - Production PWA Service Worker (v2.0.5)
// Network-First strategy with instant offline fallback

const CACHE_NAME = 'akb-billing-v205';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './version.json',
  './icon-192.png',
  './icon-512.png',
  './icon.ico'
];

// Install: Cache essential app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('PWA: Some static assets failed to pre-cache:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate: Clean up old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Network-First for HTML/App shell, network-only for APIs
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Bypass all external and mutation APIs (Supabase, Google Apps Script, Node API, non-GET)
  if (
    req.method !== 'GET' ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('script.google.com') ||
    url.pathname.includes('/api/') ||
    url.pathname.includes('/whatsapp/') ||
    url.protocol === 'chrome-extension:'
  ) {
    return;
  }

  // 2. Network-First strategy for application files
  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return networkRes;
      })
      .catch(() => {
        // Fallback to cache when offline
        return caches.match(req).then((cachedRes) => {
          if (cachedRes) return cachedRes;
          // If navigation request fails, return cached index.html
          if (req.mode === 'navigate') {
            return caches.match('./index.html') || caches.match('./');
          }
          return new Response('Network offline', { status: 503, statusText: 'Offline' });
        });
      })
  );
});

// Allow app to trigger instant update
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});
