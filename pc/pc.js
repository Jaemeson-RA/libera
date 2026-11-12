/* Libera web — page PC : affiche un code (et un QR), reçoit les fichiers de l'iPhone en direct (WebRTC) et les enregistre
 *  - dans un dossier choisi (File System Access : Chrome, Edge), rangés par mois si l'option est cochée ;
 *  - ou dans un ZIP téléchargé en flux (service worker), sinon assemblé en mémoire (dernier recours).
 * Les fichiers ne passent par aucun serveur. Le relais ne sert qu'à se trouver (quelques Ko). */
(function () {
  const { t, $, esc, ic, bytes, count, plural, eta, code6, toast } = LB;
  const FS = "showDirectoryPicker" in window;
  const PHONE = LB.pageUrl("iphone");
  const FLUSH = 1 << 20;

  const S = {
    code: "", relay: "connecting", phone: "none", route: "",
    dest: null, zip: null, byMonth: true, saved: null,
    batch: null, last: null, recent: [], cur: null, err: "",
  };
  try { S.byMonth = localStorage.getItem("libera.byMonth") !== "0"; } catch (e) { /* stockage indisponible */ }
  let sig = null, peer = null;
  let Q = Promise.resolve(); // une seule file pour tout ce qui écrit : l'ordre des fichiers est garanti

  /* ---------- noms de fichiers sûrs pour Windows ---------- */
  function safeName(n) {
    let s = String(n || "fichier").normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "").trim();
    if (!s || /^\.+$/.test(s)) s = "fichier";
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = "_" + s;
    if (s.length > 150) { const m = /(\.[^.]{1,8})$/.exec(s); s = s.slice(0, 150 - (m ? m[1].length : 0)) + (m ? m[1] : ""); }
    return s;
  }
  const split = n => { const m = /^(.*?)(\.[^.]{1,8})?$/.exec(n); return [m[1], m[2] || ""]; };
  const month = ms => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
  const stamp = () => { const d = new Date(), p = x => String(x).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + "h" + p(d.getMinutes()); };

  async function existing(dir, name) {
    try { return await (await dir.getFileHandle(name)).getFile(); } catch (e) { return null; }
  }
  async function freeName(dir, name) {
    const [b, x] = split(name);
    for (let k = 1; k < 10000; k++) { const n = b + " (" + k + ")" + x; if (!(await existing(dir, n))) return n; }
    return b + " " + LB.rid() + x;
  }

  /* ---------- dossier mémorisé (IndexedDB : le navigateur garde le droit d'accès, rien ne sort du PC) ---------- */
  function idb(op, val) {
    return new Promise(res => {
      let r;
      try { r = indexedDB.open("libera", 1); } catch (e) { res(null); return; }
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onerror = () => res(null);
      r.onsuccess = () => {
        try {
          const st = r.result.transaction("kv", op === "get" ? "readonly" : "readwrite").objectStore("kv");
          const q = op === "get" ? st.get("dir") : st.put(val, "dir");
          q.onsuccess = () => res(q.result || null); q.onerror = () => res(null);
        } catch (e) { res(null); }
      };
    });
  }

  function setDest(d) {
    S.dest = d; S.err = "";
    render();
    if (peer) sendReady(peer);
  }
  async function chooseDir() {
    try {
      const h = await window.showDirectoryPicker({ id: "libera", mode: "readwrite", startIn: "pictures" });
      S.saved = h; idb("put", h);
      setDest({ kind: "dir", h, label: h.name });
    } catch (e) {
      if (e.name !== "AbortError") toast(t("Ce dossier n'est pas autorisé par le navigateur : créez ou choisissez un sous-dossier, par exemple dans Images."), 6000);
    }
  }
  async function useSaved() {
    const h = S.saved;
    try {
      if ((await h.requestPermission({ mode: "readwrite" })) === "granted") setDest({ kind: "dir", h, label: h.name });
    } catch (e) { S.saved = null; render(); }
  }

  /* ---------- ZIP téléchargé en flux ---------- */
  const swWait = new Map();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.onmessage = e => {
      const d = e.data || {};
      if (d.t === "started" && swWait.has(d.id)) { swWait.get(d.id)(true); swWait.delete(d.id); }
    };
  }
  async function worker() {
    if (!("serviceWorker" in navigator) || LB.params.has("nosw")) return null;
    try {
      await navigator.serviceWorker.register("sw.js");
      const reg = await Promise.race([navigator.serviceWorker.ready, LB.sleep(4000).then(() => null)]);
      return reg && reg.active;
    } catch (e) { return null; }
  }
  async function openZip() {
    const name = "Libera " + stamp() + ".zip";
    const w = await worker();
    if (w) {
      const id = LB.rid();
      const started = new Promise(res => { swWait.set(id, res); setTimeout(() => res(false), 5000); });
      w.postMessage({ t: "open", id, name });
      const ifr = document.createElement("iframe");
      ifr.hidden = true; ifr.src = "dl/" + id + "/" + encodeURIComponent(name);
      document.body.appendChild(ifr);
      if (await started) {
        const ping = setInterval(() => w.postMessage({ t: "ping" }), 10000);
        return {
          name, via: "sw",
          write: async u8 => {
            const b = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
            w.postMessage({ t: "chunk", id, buf: b }, [b]);
          },
          close: () => { clearInterval(ping); w.postMessage({ t: "close", id }); setTimeout(() => ifr.remove(), 120000); },
        };
      }
      ifr.remove();
      w.postMessage({ t: "abort", id });
    }
    // dernier recours : ZIP assemblé en mémoire puis téléchargé à la fin du lot
    const parts = [];
    return {
      name, via: "mem",
      write: async u8 => { parts.push(u8); },
      close: () => {
        const url = URL.createObjectURL(new Blob(parts, { type: "application/zip" }));
        parts.length = 0;
        const a = document.createElement("a");
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      },
    };
  }
  async function chooseZip() {
    if (S.batch) return;
    S.zipping = true; render();
    try {
      S.zip = await openZip();
      setDest({ kind: "zip", label: S.zip.name });
    } finally { S.zipping = false; render(); }
  }

  /* ---------- relais de signalisation ---------- */
  function openRoom() {
    S.relay = "connecting"; S.code = ""; render();
    sig = LB.signal("role=pc", onSig, () => {
      S.relay = "down"; S.code = ""; render();
      setTimeout(openRoom, 3000);
    });
  }
  async function onSig(m) {
    try {
      if (m.t === "room") { S.code = m.code; S.relay = "ok"; render(); }
      else if (m.t === "peer") newPeer(m.pid);
      else if (m.t === "left") {
        if (peer && peer.pid === m.pid && !(peer.dc && peer.dc.readyState === "open")) { dropPeer(); S.phone = S.batch ? "lost" : "none"; render(); }
      } else if (m.t === "sdp" && peer) {
        const p = peer;
        await p.pc.setRemoteDescription(m.d);
        p.remote = true;
        for (const c of p.ice.splice(0)) { try { await p.pc.addIceCandidate(c); } catch (e) { /* ignoré */ } }
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        sig.send({ t: "sdp", d: p.pc.localDescription });
      } else if (m.t === "ice" && peer) {
        if (peer.remote) { try { await peer.pc.addIceCandidate(m.d); } catch (e) { /* ignoré */ } } else peer.ice.push(m.d);
      } else if (m.t === "err" && m.e === "busy") { S.relay = "down"; render(); }
    } catch (e) { console.error(e); }
  }

  /* ---------- connexion directe avec l'iPhone ---------- */
  function newPeer(pid) {
    dropPeer();
    const pc = new RTCPeerConnection({ iceServers: LB.ICE });
    const p = peer = { pc, dc: null, pid, ice: [], remote: false, done: 0, told: 0, gone: false };
    S.phone = "connecting"; S.route = ""; render();
    pc.onicecandidate = e => { if (e.candidate && sig) sig.send({ t: "ice", d: e.candidate.toJSON() }); };
    pc.ondatachannel = e => {
      const dc = p.dc = e.channel;
      dc.binaryType = "arraybuffer";
      dc.onopen = async () => { if (peer !== p) return; S.phone = "on"; render(); S.route = await LB.routeKind(pc); render(); };
      dc.onmessage = ev => { const d = ev.data; Q = Q.then(() => handle(p, d)).catch(err => fatal(p, err)); };
      dc.onclose = () => lost(p);
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed" || pc.connectionState === "closed") lost(p); };
  }
  function lost(p) {
    if (p.gone) return;
    p.gone = true;
    Q = Q.then(abortCurrent);
    try { p.pc.close(); } catch (e) { /* fermé */ }
    if (peer === p) { peer = null; S.phone = S.batch ? "lost" : "none"; render(); }
  }
  function dropPeer() { if (peer) lost(peer); }
  const send = (p, o) => { if (p && p.dc && p.dc.readyState === "open") p.dc.send(JSON.stringify(o)); };
  function sendReady(p) {
    send(p, { t: "ready", mode: S.dest ? S.dest.kind : null, label: S.dest ? S.dest.label : "", zipOpen: !!S.zip, bid: S.batch ? S.batch.bid : null, have: S.batch ? Array.from(S.batch.ids) : [] });
  }
  // crédit de contre-pression : l'iPhone n'envoie pas plus de 8 Mo d'avance sur ce qui est écrit
  function credit(p, n, force) {
    p.done += n;
    if (force || p.done - p.told >= FLUSH) { p.told = p.done; send(p, { t: "w", n: p.done }); }
  }

  /* ---------- réception ---------- */
  async function handle(p, d) {
    if (p.gone) return;
    if (typeof d !== "string") return chunk(p, new Uint8Array(d));
    const m = JSON.parse(d);
    if (m.t === "hello") sendReady(p);
    else if (m.t === "batch") await beginBatch(p, m);
    else if (m.t === "f") await beginFile(p, m);
    else if (m.t === "e") await endFile(p, m);
    else if (m.t === "end") await endBatch(p, m);
  }

  async function beginBatch(p, m) {
    if (S.batch && S.batch.bid === m.bid) { render(); return; } // reprise après une coupure
    if (S.batch) await closeBatch();
    if (!S.dest || (S.dest.kind === "zip" && !S.zip)) { send(p, { t: "err", e: t("choisissez d'abord où enregistrer sur le PC") }); return; }
    S.batch = { bid: m.bid, n: m.n, bytes: m.bytes, ids: new Set(), got: 0, gotB: 0, skipped: 0, start: Date.now(), names: new Set(), mode: S.dest.kind, label: S.dest.label };
    if (S.dest.kind === "zip") S.zip.zw = new ZipStream(S.zip.write);
    S.last = null; S.recent = [];
    render();
  }

  async function beginFile(p, m) {
    const b = S.batch;
    if (!b) return;
    const name = safeName(m.name), sub = S.byMonth && m.date ? month(m.date) : "";
    const base = { id: m.id, size: +m.size || 0, n: 0, buf: [], bufLen: 0, date: m.date };
    if (b.mode === "dir") {
      const dir = sub ? await S.dest.h.getDirectoryHandle(sub, { create: true }) : S.dest.h;
      const ex = await existing(dir, name);
      if (ex && ex.size === base.size) { // déjà là (envoi précédent) : on ne réécrit pas
        S.cur = Object.assign(base, { skip: true, path: (sub ? sub + "/" : "") + name });
        send(p, { t: "skip", id: m.id });
        return;
      }
      // fichier vide laissé par une coupure : on le réécrit ; sinon, nom libre « (1) »
      const final = ex && ex.size ? await freeName(dir, name) : name;
      const w = await (await dir.getFileHandle(final, { create: true })).createWritable();
      S.cur = Object.assign(base, { w, dir, name: final, created: !ex, path: (sub ? sub + "/" : "") + final });
    } else {
      let path = (sub ? sub + "/" : "") + name;
      if (b.names.has(path.toLowerCase())) {
        const [x, y] = split(path);
        let k = 1; while (b.names.has((x + " (" + k + ")" + y).toLowerCase())) k++;
        path = x + " (" + k + ")" + y;
      }
      await S.zip.zw.begin(path, base.size, m.date);
      S.cur = Object.assign(base, { path });
    }
  }

  async function flush(p) {
    const c = S.cur;
    if (!c || !c.bufLen) return;
    const n = c.bufLen;
    const out = new Uint8Array(n);
    let o = 0;
    for (const u of c.buf) { out.set(u, o); o += u.length; }
    c.buf = []; c.bufLen = 0;
    if (c.w) await c.w.write(out); else await S.zip.zw.data(out);
    credit(p, n);
  }

  async function chunk(p, u8) {
    const c = S.cur;
    if (!c || c.skip) { credit(p, u8.length); return; }
    c.buf.push(u8); c.bufLen += u8.length; c.n += u8.length;
    if (c.bufLen >= FLUSH) await flush(p);
  }

  async function endFile(p, m) {
    const c = S.cur, b = S.batch;
    if (!c || c.id !== m.id || !b) return;
    if (!c.skip) {
      await flush(p);
      if (c.n !== c.size) { await abortCurrent(); credit(p, 0, true); return; } // incomplet : rien n'est gardé
      if (c.w) await c.w.close(); else { await S.zip.zw.end(); b.names.add(c.path.toLowerCase()); }
    }
    S.cur = null;
    b.ids.add(c.id); b.got++; b.gotB += c.size;
    if (c.skip) b.skipped++;
    S.recent.unshift({ path: c.path, size: c.size, skip: !!c.skip });
    if (S.recent.length > 8) S.recent.pop();
    send(p, { t: "ok", id: c.id, saved: b.mode === "dir", skipped: !!c.skip });
    credit(p, 0, true);
    soon();
  }

  async function endBatch(p, m) {
    if (!S.batch || S.batch.bid !== m.bid) return;
    await closeBatch();
    send(p, { t: "saved", bid: m.bid });
    sendReady(p);
  }

  async function closeBatch() {
    const b = S.batch;
    if (!b) return;
    if (S.cur) await abortCurrent();
    if (b.mode === "zip" && S.zip) {
      await S.zip.zw.finish();
      S.zip.close();
      b.zipName = S.zip.name; b.via = S.zip.via;
      S.zip = null;
      if (S.dest && S.dest.kind === "zip") S.dest = null; // un nouveau ZIP demande un nouveau clic
    }
    b.end = Date.now();
    S.last = b; S.batch = null;
    render();
  }

  async function abortCurrent() {
    const c = S.cur;
    S.cur = null;
    if (!c || c.skip) return;
    if (c.w) {
      try { await c.w.abort(); } catch (e) { /* déjà fermé */ }
      if (c.created) { try { await c.dir.removeEntry(c.name); } catch (e) { /* déjà supprimé */ } } // rien de partiel ne reste
    }
    else if (S.zip && S.zip.zw) S.zip.zw.drop();
  }

  async function fatal(p, err) {
    console.error(err);
    const msg = err && err.name === "QuotaExceededError" ? t("disque plein") : err && err.name === "NotAllowedError" ? t("accès au dossier refusé") : (err && err.message) || String(err);
    S.err = msg;
    send(p, { t: "err", e: msg });
    await abortCurrent();
    render();
    try { p.dc.close(); } catch (e) { /* fermé */ }
  }

  /* ---------- rendu ---------- */
  let soonT = 0;
  function soon() { if (!soonT) soonT = setTimeout(() => { soonT = 0; renderRecv(); }, 300); }

  function render() {
    const phoneUrl = S.code ? PHONE + "#c=" + S.code : PHONE;
    const st = {
      none: [S.code ? "loader-circle" : "", t("En attente de l'iPhone…"), ""],
      connecting: ["loader-circle", t("Connexion de l'iPhone…"), ""],
      on: ["circle-check", t("iPhone connecté") + (S.route === "lan" ? " · " + t("même Wi-Fi") : S.route === "internet" ? " · " + t("par Internet") : ""), "good"],
      lost: ["triangle-alert", t("Connexion perdue : l'iPhone peut reprendre avec le même code."), "warn"],
    }[S.phone];
    const busy = !!S.batch;
    const dirOn = S.dest && S.dest.kind === "dir", zipOn = S.dest && S.dest.kind === "zip" && S.zip;
    $("#view").innerHTML =
      '<div class="pc-grid">' +
      '<section class="card pc-card"><div class="step-lbl"><span class="num">1</span>' + esc(t("Sur l'iPhone")) + "</div>" +
      (S.code
        ? '<div class="qr">' + QR.svg(phoneUrl, 200) + "</div>" +
          '<p class="muted small center">' + esc(t("Scannez ce QR code avec l'appareil photo de l'iPhone. Ou ouvrez dans Safari :")) + '<br><span class="mono">' + esc(LB.shortUrl(PHONE)) + "</span> " + esc(t("et tapez :")) + "</p>" +
          '<div class="code-box num" aria-label="' + esc(t("Code")) + '">' + esc(code6(S.code)) + "</div>"
        : '<div class="qr empty-qr">' + ic(S.relay === "down" ? "wifi-off" : "loader-circle", S.relay === "down" ? "" : "spin") + "</div>" +
          '<p class="muted small center">' + esc(S.relay === "down" ? t("Pas de connexion à Internet : nouvel essai dans quelques secondes…") : t("Création du code…")) + "</p>") +
      '<div class="status ' + st[2] + '">' + (st[0] ? ic(st[0], st[0] === "loader-circle" ? "spin" : "") : "") + "<span>" + esc(st[1]) + "</span></div></section>" +

      '<section class="card pc-card"><div class="step-lbl"><span class="num">2</span>' + esc(t("Où enregistrer sur ce PC")) + "</div>" +
      (FS
        ? (S.saved && !dirOn ? '<button class="choice" data-action="use-saved"' + (busy ? " disabled" : "") + '><span class="radio"></span><div class="grow"><div class="t">' + esc(t("Continuer dans « {name} »", { name: S.saved.name })) + '</div><div class="s">' + esc(t("Le dossier de la dernière fois.")) + "</div></div></button>" : "") +
          '<button class="choice' + (dirOn ? " on" : "") + '" data-action="dir"' + (busy ? " disabled" : "") + '><span class="radio"></span><div class="grow"><div class="t">' + esc(dirOn ? t("Dossier « {name} »", { name: S.dest.label }) : t("Choisir un dossier")) + '</div><div class="s">' + esc(t("Recommandé : les fichiers arrivent directement dedans. Le navigateur demande l'autorisation de les enregistrer.")) + "</div></div>" + ic("folder-open") + "</button>"
        : '<div class="note">' + ic("info") + "<div>" + esc(t("Pour enregistrer directement dans un dossier, ouvrez cette page dans Chrome ou Edge.")) + "</div></div>") +
      '<button class="choice' + (zipOn ? " on" : "") + '" data-action="zip"' + (busy || S.zipping ? " disabled" : "") + '><span class="radio"></span><div class="grow"><div class="t">' + esc(zipOn ? t("ZIP prêt à recevoir") : t("Télécharger un ZIP")) + '</div><div class="s">' + esc(zipOn ? t("Le téléchargement est ouvert : il se remplit pendant l'envoi.") : t("Un seul fichier dans Téléchargements, à extraire ensuite. Marche dans tous les navigateurs.")) + "</div></div>" + ic("file-archive") + "</button>" +
      '<button class="tile-btn small-opt' + (S.byMonth ? " on" : "") + '" data-action="month"' + (busy ? " disabled" : "") + '><span class="check">' + ic("check") + "</span><span>" + esc(t("Un sous-dossier par mois (2026-08, 2026-09…)")) + "</span></button>" +
      (S.err ? '<div class="note warn">' + ic("triangle-alert") + "<div>" + esc(t("Erreur :") + " " + S.err) + "</div></div>" : "") +
      "</section></div>" +
      '<section id="recv"></section>' +
      '<div class="note">' + ic("shield-check") + "<div>" + esc(t("Les fichiers vont directement de l'iPhone à ce PC, chiffrés : ils ne passent par aucun serveur. Laissez cette page ouverte pendant l'envoi.")) + "</div></div>";
    renderRecv();
  }

  function renderRecv() {
    const el = $("#recv");
    if (!el) return;
    const b = S.batch || S.last;
    if (!b) { el.innerHTML = ""; el.className = ""; return; }
    el.className = "card";
    const live = b === S.batch;
    const secs = ((live ? Date.now() : b.end) - b.start) / 1000;
    const speed = secs > 1 ? b.gotB / secs : 0;
    const frac = b.n ? b.got / b.n : 0;
    const where = b.mode === "zip" ? (live ? b.label : t("{name} (dossier Téléchargements)", { name: b.zipName })) : t("dossier « {name} »", { name: b.label });
    el.innerHTML =
      '<div class="row"><div class="grow"><div class="h2">' + esc(live ? t("Réception en cours") : t("Terminé")) + '</div><div class="muted small">' +
      esc(t("{got} sur {n} fichiers · {size}", { got: count(b.got), n: count(b.n), size: bytes(b.gotB) })) + (live && speed ? " · " + esc(bytes(speed) + "/s") : "") + "</div></div>" +
      (live ? "" : ic("circle-check", "done-ic")) + "</div>" +
      '<div class="progress" style="margin:12px 0"><span style="width:' + (live ? frac * 100 : 100).toFixed(1) + '%"></span></div>' +
      '<div class="muted small">' + esc(t("Enregistré dans :")) + " <b>" + esc(where) + "</b>" + (b.skipped ? " · " + esc(plural(b.skipped, "fichier déjà présent, non réécrit", "fichiers déjà présents, non réécrits")) : "") + "</div>" +
      (live && speed && b.bytes ? '<div class="faint small">' + esc(eta((b.bytes - b.gotB) / speed)) + "</div>" : "") +
      (S.recent.length ? '<div class="recent">' + S.recent.map(r => '<div class="kv"><span class="ellipsis">' + esc(r.path) + (r.skip ? ' <span class="badge">' + esc(t("déjà là")) + "</span>" : "") + '</span><span class="num">' + esc(bytes(r.size)) + "</span></div>").join("") + "</div>" : "") +
      (!live && b.mode === "zip" ? '<div class="note">' + ic("info") + "<div>" + esc(t("Pour un autre envoi, cliquez de nouveau sur « Télécharger un ZIP » (un ZIP par envoi).")) + "</div></div>" : "") +
      (!live ? '<div class="note">' + ic("smartphone") + "<div>" + esc(t("Vérifiez quelques photos ici, puis suivez sur l'iPhone les étapes pour libérer la place.")) + "</div></div>" : "");
  }

  /* ---------- actions ---------- */
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-action]");
    if (!b || b.disabled) return;
    const a = b.dataset.action;
    if (a === "dir") chooseDir();
    else if (a === "use-saved") useSaved();
    else if (a === "zip") chooseZip();
    else if (a === "month") {
      S.byMonth = !S.byMonth;
      try { localStorage.setItem("libera.byMonth", S.byMonth ? "1" : "0"); } catch (x) { /* stockage indisponible */ }
      render();
    }
  });
  window.addEventListener("beforeunload", e => { if (S.batch) { e.preventDefault(); e.returnValue = ""; } });

  LB.initLang(render);
  render();
  openRoom();
  (async () => {
    // tests automatiques en local : ?opfs=1 enregistre dans le stockage privé du navigateur (même code que pour un dossier)
    if (LB.local && LB.params.has("opfs")) {
      const h = await navigator.storage.getDirectory();
      setDest({ kind: "dir", h, label: "OPFS" });
      return;
    }
    if (!FS) return;
    const h = await idb("get");
    if (!h) return;
    S.saved = h;
    try { if ((await h.queryPermission({ mode: "readwrite" })) === "granted") { setDest({ kind: "dir", h, label: h.name }); return; } } catch (e) { /* droit perdu */ }
    render();
  })();
  if (LB.local) { window.__libera = S; window.__liberaDrop = () => dropPeer(); } // tests locaux : état et coupure simulée
})();
