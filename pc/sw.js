/* Libera web — service worker de la page PC : transforme le ZIP fabriqué par la page en téléchargement « normal »,
 * écrit sur le disque au fur et à mesure (rien ne reste en mémoire). Les octets viennent de la page, jamais du réseau. */
const streams = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.t === "open") {
    let ctl;
    const rs = new ReadableStream({ start(c) { ctl = c; } });
    streams.set(d.id, { rs, ctl, name: d.name, client: e.source });
  } else if (d.t === "chunk") {
    const s = streams.get(d.id);
    if (s) s.ctl.enqueue(new Uint8Array(d.buf));
  } else if (d.t === "close" || d.t === "abort") {
    const s = streams.get(d.id);
    if (!s) return;
    streams.delete(d.id);
    try { if (d.t === "close") s.ctl.close(); else s.ctl.error(new Error("aborted")); } catch (x) { /* déjà fermé */ }
  }
  // « ping » : le simple fait de recevoir un message garde le service worker éveillé pendant un long envoi
});

self.addEventListener("fetch", e => {
  const m = /\/dl\/([a-z0-9]+)\/[^/]*$/.exec(new URL(e.request.url).pathname);
  if (!m) return;
  const s = streams.get(m[1]);
  if (!s || !s.rs) { e.respondWith(new Response("Libera: download expired", { status: 404 })); return; }
  const rs = s.rs;
  s.rs = null;
  if (s.client) s.client.postMessage({ t: "started", id: m[1] });
  e.respondWith(new Response(rs, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(s.name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  }));
});
