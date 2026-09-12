// Service worker: makes the game installable and playable offline after the
// first load.
//
// Strategy is deliberately simple and split by content type:
//   - HTML: network-first, so a fresh deploy is what players see; falls back
//     to the cached copy when offline.
//   - Everything else (three.js, game code, models, icons): cache-first,
//     since none of it changes without a new CACHE_VERSION below, and
//     re-fetching 6 MB of models on every visit would be wasteful.
//
// Bump CACHE_VERSION when shipping a change that must not be served stale
// (a gameplay fix, say) — that alone invalidates every cached response.

const CACHE_VERSION = "v1";
const CACHE_NAME = `liberty-grid-${CACHE_VERSION}`;

// Warmed at install so the very first offline launch already has the
// essentials; everything else fills in as it's fetched.
const PRECACHE = [
  "./",
  "./index.html",
  "./play.html",
  "./manifest.webmanifest",
  "./assets/models/manifest.json",
  "./assets/models/custom/index.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

function isHTML(request) {
  return request.mode === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never proxy the CDNs

  if (isHTML(req)) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}
