/* Libera web — outils communs aux pages iPhone et PC : textes, formats, icônes, relais de signalisation, WebRTC.
 * Sécurité : tout texte venant de l'autre appareil (noms de fichiers) passe par esc() avant insertion HTML. */
(function () {
  const L = window.I18N;
  const t = (k, v) => L.t(k, v);
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ic = (name, cls) => '<svg class="ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ((window.ICONS || {})[name] || "") + "</svg>";

  /* ---------- formats (mêmes règles que l'appli : Go/Mo en français, GB/MB sinon) ---------- */
  const cache = {};
  const nf = d => cache[L.locale() + d] || (cache[L.locale() + d] = new Intl.NumberFormat(L.locale(), { maximumFractionDigits: d }));
  function bytes(b) {
    if (b == null || b < 0) return "—";
    const u = L.get() === "fr" ? ["o", "Ko", "Mo", "Go", "To"] : ["B", "KB", "MB", "GB", "TB"];
    if (b < 1000) return nf(0).format(b) + " " + u[0];
    if (b < 1e6) return nf(0).format(b / 1e3) + " " + u[1];
    if (b < 1e9) return nf(b < 1e7 ? 1 : 0).format(b / 1e6) + " " + u[2];
    if (b < 1e12) return nf(1).format(b / 1e9) + " " + u[3];
    return nf(1).format(b / 1e12) + " " + u[4];
  }
  const count = n => nf(0).format(n);
  const plural = (n, one, many) => count(n) + " " + t(n > 1 ? many : one);
  function date(ms, withYear) {
    const k = "d" + L.locale() + (withYear === false ? "n" : "y");
    const f = cache[k] || (cache[k] = new Intl.DateTimeFormat(L.locale(), withYear === false ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }));
    return f.format(new Date(ms));
  }
  function duration(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(r).padStart(2, "0");
  }
  function eta(sec) {
    if (!isFinite(sec) || sec <= 0) return "";
    if (sec < 60) return t("moins d'une minute");
    const m = Math.round(sec / 60);
    return m < 60 ? t("environ {n} min", { n: m }) : t("environ {h} h {m} min", { h: Math.floor(m / 60), m: m % 60 });
  }
  const code6 = c => String(c).replace(/\D/g, "").replace(/^(\d{3})(\d{3})$/, "$1 $2");

  /* ---------- langue (même clé que la page Android : un seul choix pour tout Libera) ---------- */
  function initLang(onChange) {
    let saved = null;
    try { saved = localStorage.getItem("lang"); } catch (e) { /* stockage indisponible */ }
    const nav = (navigator.language || "es").slice(0, 2);
    const q = new URLSearchParams(location.search).get("lang");
    L.set(q || saved || (nav === "fr" || nav === "en" ? nav : "es"));
    const apply = () => {
      $$("[data-t]").forEach(el => { el.textContent = t(el.dataset.t); });
      $$("[data-t-aria]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.tAria)); });
      $$("[data-t-html]").forEach(el => { el.innerHTML = t(el.dataset.tHtml); });
      $$(".langs button").forEach(b => b.classList.toggle("on", b.dataset.l === L.get()));
      document.title = t(document.body.dataset.title || "Libera");
    };
    $$(".langs button").forEach(b => {
      b.onclick = () => {
        L.set(b.dataset.l);
        try { localStorage.setItem("lang", L.get()); } catch (e) { /* stockage indisponible */ }
        apply();
        if (onChange) onChange();
      };
    });
    $$("[data-ic]").forEach(el => { el.innerHTML = ic(el.dataset.ic); });
    apply();
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg, ms) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3200);
  }

  /* ---------- adresses ---------- */
  const params = new URLSearchParams(location.search);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const RELAY = params.get("relay") || (local ? "ws://" + location.hostname + ":8788" : "wss://libera-relay.jaemeson-dieu.workers.dev");
  const pageUrl = which => new URL("../" + which + "/", location.href).href;
  const shortUrl = u => u.replace(/^https?:\/\//, "").replace(/\/$/, "");

  /* ---------- relais de signalisation (WebSocket) ---------- */
  function signal(query, onMsg, onClose) {
    const ws = new WebSocket(RELAY.replace(/\/$/, "") + "/ws?" + query);
    let ping = null, closed = false;
    ws.onopen = () => { ping = setInterval(() => { try { ws.send("ping"); } catch (e) { /* fermé */ } }, 25000); };
    ws.onmessage = e => {
      if (e.data === "pong") return;
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      onMsg(m);
    };
    const end = ev => {
      if (closed) return;
      closed = true; clearInterval(ping);
      if (onClose) onClose(ev);
    };
    ws.onclose = end;
    ws.onerror = () => { /* suivi de onclose */ };
    return {
      send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      close() { closed = true; clearInterval(ping); try { ws.close(1000); } catch (e) { /* déjà fermé */ } },
      get open() { return ws.readyState === 1; },
    };
  }

  /* ---------- WebRTC ---------- */
  // serveurs STUN publics et gratuits : ils indiquent seulement l'adresse vue d'Internet, aucun fichier n'y passe.
  // Pas de serveur TURN (relais de données) : les fichiers ne passent jamais par un serveur.
  const ICE = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const CHUNK = 64 * 1024;          // taille d'un message de données (compatible Safari / Chrome / Firefox)
  const WINDOW = 8 * 1024 * 1024;   // octets envoyés mais pas encore écrits sur le PC (contre-pression, < 16 Mo de file Chrome)

  /* chemin réseau : « host » ou « prflx » (adresse découverte pendant la connexion, typique du même Wi-Fi) = local ;
   * « srflx » = adresse publique (par Internet, toujours direct, sans serveur) */
  async function routeKind(pc) {
    try {
      const st = await pc.getStats();
      let pair = null;
      st.forEach(r => { if (r.type === "transport" && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
      if (!pair) st.forEach(r => { if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) pair = pair || r; });
      if (!pair) return "unknown";
      const l = st.get(pair.localCandidateId), r = st.get(pair.remoteCandidateId);
      const types = [l && l.candidateType, r && r.candidateType];
      if (types.includes("relay")) return "relay";
      return types.includes("srflx") ? "internet" : "lan";
    } catch (e) { return "unknown"; }
  }

  /* écran allumé pendant l'envoi (Safari 16.4+, Chrome) */
  let lock = null;
  async function keepAwake(on) {
    try {
      if (on && !lock && navigator.wakeLock && document.visibilityState === "visible") {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => { lock = null; });
      } else if (!on && lock) { await lock.release(); lock = null; }
    } catch (e) { lock = null; }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  window.LB = { t, $, $$, esc, ic, bytes, count, plural, date, duration, eta, code6, initLang, toast, RELAY, local, params, pageUrl, shortUrl, signal, ICE, CHUNK, WINDOW, routeKind, keepAwake, sleep, rid };
})();
