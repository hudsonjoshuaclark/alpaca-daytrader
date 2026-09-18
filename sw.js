// Service worker for the phone dashboard (/phone).
//
// It exists for one failure: the desk machine is asleep or the ngrok tunnel is down, and
// the home-screen app opens onto ngrok's ERR_NGROK_3200 page instead of anything of ours.
// With the shell cached, the app opens to its own "can't reach the bot server" screen,
// which at least says what is wrong and offers a retry.
//
// What it deliberately does NOT do: cache a single byte of account data. Only the page
// shell and the icon are stored. Every /api/ request goes straight to the network, so a
// figure on screen is always one this session actually fetched, never a replay. An app
// that shows yesterday's P&L as though it were live is worse than one that shows nothing.

const CACHE = 'bots-shell-v1';
const SHELL_URL = '/phone';
// Public, unauthenticated, and tiny - safe to precache without risking a failed install.
const PRECACHE = ['/assets/phone-icon-180.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE).catch(() => {});
    // Seed the shell here, not just from intercepted navigations. A worker does not
    // control the page that registered it, so that first good load - the only one there
    // may ever be before an outage - passes by uncached. Without this the app still lands
    // on the proxy's error page the very first time the tunnel drops, which is precisely
    // the case this worker exists for.
    await cacheShell(cache).catch(() => {});
    await self.skipWaiting();
  })());
});

// Every write to the shell cache goes through here, so the marker check guarding what may
// be stored lives in exactly one place.
async function cacheShell(cache, response) {
  const res = response || await fetch(SHELL_URL, { credentials: 'same-origin', cache: 'reload' });
  if (res.ok && res.headers.has('X-Bot-Dashboard')) await cache.put(SHELL_URL, res.clone());
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never touch anything that reads or changes an account. /api/close in particular must
  // reach the network exactly once, unaltered, or not at all.
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  // Icon and manifest: cache-first, they change about once a year.
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});

async function handleNavigation(req) {
  try {
    const res = await fetch(req);

    // "Did the fetch succeed" is the wrong test here. An ngrok offline page, a captive
    // portal and a proxy error are all perfectly valid HTTP responses carrying somebody
    // else's HTML. The only response worth showing or storing is one the dashboard itself
    // served, which it marks with this header.
    if (res.ok && res.headers.has('X-Bot-Dashboard')) {
      // Keyed on the shell URL, so /phone.html and / all restore the same cached page.
      await cacheShell(await caches.open(CACHE), res);
      return res;
    }

    // A 401 has to reach the browser or the basic-auth prompt never appears and the app
    // is permanently locked out of its own server.
    if (res.status === 401) return res;

    return (await caches.match(SHELL_URL)) || res;
  } catch (err) {
    // Genuine network failure: no DNS, no route, airplane mode.
    const cached = await caches.match(SHELL_URL);
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="font:15px -apple-system,system-ui,sans-serif;background:#0d0d0d;color:#fff;padding:32px">' +
      '<h1 style="font-size:17px">Trading Bots</h1>' +
      '<p style="color:#c3c2b7">Offline, and no copy of the dashboard has been saved on this ' +
      'device yet. Open it once while the tunnel is up and this screen will not come back.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}
