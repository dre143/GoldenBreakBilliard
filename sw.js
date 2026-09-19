// Offline safety net, from the Marimar Inn tablet app: network first, cache as a fallback.
//
// Every successful GET of the app's own files (and the Firebase SDK and fonts it loads from Google's
// CDNs) is saved as it's fetched. If the network is down, the saved copy is served instead. So when
// the tablet loses Wi-Fi and the app reloads (Android can kill and restart the page at any time), it
// still opens instead of showing "Webpage not available". Nothing is precached, so a new deploy is
// picked up on the next online load.
//
// Firestore and Firebase Auth traffic is never touched: the Firestore SDK keeps its own offline cache.

const CACHE_NAME = 'goldenbreak-runtime-v1';
const CDN_HOSTS = new Set(['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const cacheable = request.method === 'GET' && (url.origin === self.location.origin || CDN_HOSTS.has(url.hostname));
  if (!cacheable) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // The app is one page: an offline reload with a different query (e.g. the tablet app's ?v=1)
        // still gets the saved page.
        if (request.mode === 'navigate') {
          const page = await caches.match(request, { ignoreSearch: true })
            || await caches.match(new URL('./', self.location).href, { ignoreSearch: true });
          if (page) return page;
        }
        throw new Error('Offline and not cached.');
      }),
  );
});
