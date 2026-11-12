/* Libera web — service worker de la page iPhone : garde l'appli en cache pour qu'elle s'ouvre vite depuis l'écran d'accueil.
 * Pages : réseau d'abord (mises à jour), cache si hors ligne. Fichiers versionnés (?v=…) : cache d'abord. */
const V = "libera-iphone-a5d1e1fc";
const FILES = ["./", "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "app.css?v=a5d1e1fc", "web.css?v=a5d1e1fc", "i18n.js?v=a5d1e1fc", "common.js?v=a5d1e1fc", "meta.js?v=a5d1e1fc", "phone.js?v=a5d1e1fc", "icons.js?v=a5d1e1fc", "fonts/dm-sans-v17-latin_latin-ext-500.woff2", "fonts/dm-sans-v17-latin_latin-ext-700.woff2", "fonts/inter-v20-latin_latin-ext-600.woff2"];

self.addEventListener("install", e => e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("libera-iphone-") && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  if (r.mode === "navigate") {
    e.respondWith(fetch(r).then(res => {
      const copy = res.clone();
      caches.open(V).then(c => c.put("./", copy));
      return res;
    }).catch(() => caches.match("./")));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r)));
});
