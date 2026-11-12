/* Libera web — page iPhone : choix des photos et vidéos, tri, compression facultative, envoi direct au PC (WebRTC).
 * Rien n'est envoyé à un serveur : le relais ne voit que les messages de connexion, les fichiers vont du téléphone au PC. */
(function () {
  const { t, $, esc, ic, bytes, count, plural, date, duration, eta, code6, toast, CHUNK, WINDOW } = LB;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const desktop = !isIOS && matchMedia("(hover: hover) and (pointer: fine)").matches;
  const PC_URL = LB.shortUrl(LB.pageUrl("pc"));
  const PHOTO = { edge: 2560, q: 0.85, ratio: 0.42, png: 0.25 }; // même réglage que « léger » dans l'appli Android

  const S = {
    view: "home", files: [], sort: "size", compress: false,
    code: "", link: "off", linkErr: "", pc: null, route: "", wantSend: false,
    send: null, result: null,
  };
  let conn = null;

  /* ---------- fichiers ---------- */
  const kindOf = f => (/^video\//.test(f.type) || Meta.isVideo(f) ? "video" : /^image\//.test(f.type) || /\.(jpe?g|heic|heif|png|gif|webp|dng|tiff?)$/i.test(f.name) ? "photo" : null);
  const fid = f => (f.size.toString(36) + "-" + (f.lastModified || 0).toString(36) + "-" + f.name).slice(0, 160);
  const when = f => f.date || f.file.lastModified || 0;
  const sel = () => S.files.filter(f => f.sel);
  const sum = list => list.reduce((a, f) => a + f.size, 0);
  const estimate = list => list.reduce((a, f) => a + (S.compress && f.kind === "photo" && f.size > 300e3 && !/gif/i.test(f.type) ? f.size * (/png/i.test(f.type) ? PHOTO.png : PHOTO.ratio) : f.size), 0);

  function addFiles(list) {
    const have = new Set(S.files.map(f => f.id));
    let added = 0, ignored = 0;
    for (const file of list) {
      const kind = kindOf(file);
      if (!kind) { ignored++; continue; }
      const id = fid(file);
      if (have.has(id)) continue;
      have.add(id);
      S.files.push({ id, file, name: file.name || "IMG", size: file.size, type: file.type || "", kind, date: 0, sel: true, st: "todo", thumb: null, dur: 0 });
      added++;
    }
    if (ignored) toast(plural(ignored, "fichier ignoré (ni photo ni vidéo)", "fichiers ignorés (ni photo ni vidéo)"));
    if (added) { S.view = "list"; readDates(); }
    render();
  }

  // dates de prise de vue lues dans les fichiers (EXIF, QuickTime), 3 à la fois
  let dateRun = null;
  function readDates() {
    if (dateRun) return;
    dateRun = (async () => {
      const todo = () => S.files.filter(f => !f.dateDone);
      let changed = 0;
      const worker = async () => {
        for (let f = todo()[0]; f; f = todo()[0]) {
          f.dateDone = true;
          f.date = (await Meta.captureDate(f.file)) || 0;
          if (++changed % 40 === 0 && S.view === "list" && S.sort !== "size") renderList();
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      dateRun = null;
      if (S.view === "list") render();
    })();
  }

  function sorted() {
    const a = S.files.slice();
    if (S.sort === "size") a.sort((x, y) => y.size - x.size);
    else if (S.sort === "new") a.sort((x, y) => when(y) - when(x));
    else a.sort((x, y) => when(x) - when(y));
    return a;
  }

  /* ---------- aperçus (un à la fois : iOS limite fortement la mémoire des images) ---------- */
  const thumbQ = [];
  let thumbBusy = false;
  const tcv = document.createElement("canvas");
  const io = "IntersectionObserver" in window ? new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) {
      io.unobserve(e.target);
      const f = S.files.find(x => x.id === e.target.dataset.id);
      if (f && !f.thumb && !f.thumbTried) { thumbQ.push(f); pumpThumbs(); }
    }
  }, { rootMargin: "300px" }) : null;

  async function pumpThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    while (thumbQ.length) {
      const f = thumbQ.shift();
      if (f.thumb || f.thumbTried) continue;
      f.thumbTried = true;
      try { f.thumb = await (f.kind === "video" ? videoThumb(f) : imageThumb(f)); } catch (e) { f.thumb = null; }
      const el = document.querySelector('.prow[data-id="' + CSS.escape(f.id) + '"] .thumb');
      if (el && f.thumb) el.innerHTML = '<img alt="" src="' + f.thumb + '">' + (f.kind === "video" ? '<span class="vbadge">' + (f.dur ? duration(f.dur) : ic("video")) + "</span>" : "");
    }
    thumbBusy = false;
  }
  function drawCover(src, w, h) {
    const s = 112; tcv.width = s; tcv.height = s;
    const c = tcv.getContext("2d"), k = Math.max(s / w, s / h);
    c.drawImage(src, (s - w * k) / 2, (s - h * k) / 2, w * k, h * k);
    const url = tcv.toDataURL("image/jpeg", 0.7);
    tcv.width = tcv.height = 1;
    return url;
  }
  async function imageThumb(f) {
    const url = URL.createObjectURL(f.file);
    try { const img = new Image(); img.src = url; await img.decode(); return drawCover(img, img.naturalWidth, img.naturalHeight); }
    finally { URL.revokeObjectURL(url); }
  }
  function videoThumb(f) {
    return new Promise(res => {
      const url = URL.createObjectURL(f.file);
      const v = document.createElement("video");
      let done = false;
      const end = r => { if (done) return; done = true; clearTimeout(to); v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url); res(r); };
      const to = setTimeout(() => end(null), 6000);
      v.muted = true; v.playsInline = true; v.preload = "metadata";
      v.onloadedmetadata = () => { f.dur = v.duration || 0; try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch (e) { end(null); } };
      v.onseeked = () => { try { end(drawCover(v, v.videoWidth, v.videoHeight)); } catch (e) { end(null); } };
      v.onerror = () => end(null);
      v.src = url + "#t=0.5";
    });
  }

  /* ---------- compression d'une photo (canvas -> JPEG 2560 px, qualité 85, EXIF d'origine recopié) ---------- */
  const cv = document.createElement("canvas");
  async function compress(f) {
    const url = URL.createObjectURL(f.file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const w0 = img.naturalWidth, h0 = img.naturalHeight, k = Math.min(1, PHOTO.edge / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
      cv.width = w; cv.height = h;
      const c = cv.getContext("2d");
      c.imageSmoothingQuality = "high";
      c.fillStyle = "#fff"; c.fillRect(0, 0, w, h);
      c.drawImage(img, 0, 0, w, h);
      const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", PHOTO.q));
      cv.width = cv.height = 1;
      if (!blob) return null;
      return Meta.withExif(blob, await Meta.exifForCopy(f.file));
    } finally { URL.revokeObjectURL(url); }
  }
  async function prepare(f) {
    if (S.compress && f.kind === "photo" && f.size > 300e3 && !/gif|svg/i.test(f.type)) {
      try {
        const out = await compress(f);
        if (out && out.size < f.size * 0.9) return { blob: out, name: f.name.replace(/\.[^.]+$/, "") + ".jpg", type: "image/jpeg", compressed: true };
      } catch (e) { /* illisible par Safari : envoyé tel quel */ }
    }
    return { blob: f.file, name: f.name, type: f.type };
  }

  /* ---------- connexion au PC ---------- */
  const ERR = {
    nocode: "Code introuvable : vérifiez les 6 chiffres affichés sur le PC (la page PC doit rester ouverte).",
    slow: "Trop d'essais. Patientez quelques minutes.",
    busy: "Le service est saturé, réessayez dans un instant.",
    closed: "La page du PC a été fermée.",
    replaced: "Un autre téléphone s'est connecté avec ce code.",
    relay: "Pas de connexion à Internet : le téléphone et le PC doivent être en ligne pour se trouver.",
    p2p: "Le téléphone et le PC ne se voient pas. Mettez-les sur le même Wi-Fi et désactivez le VPN ou le relais privé iCloud.",
    lost: "Connexion perdue.",
  };

  function connect(code) {
    disconnect();
    S.code = code; S.link = "connecting"; S.linkErr = ""; S.pc = null;
    render();
    const pc = new RTCPeerConnection({ iceServers: LB.ICE });
    const dc = pc.createDataChannel("libera", { ordered: true });
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = 1 << 20;
    const c = conn = { pc, dc, sig: null, sent: 0, written: 0, wake: null, open: false, dead: false, timer: null };
    const wake = () => { const w = c.wake; c.wake = null; if (w) w(); };
    const fail = e => {
      if (c.dead) return;
      const wasOpen = c.open;
      c.dead = true; clearTimeout(c.timer);
      try { c.sig && c.sig.close(); } catch (x) { /* fermé */ }
      try { pc.close(); } catch (x) { /* fermé */ }
      wake();
      if (conn !== c) return;
      conn = null;
      S.link = "error"; S.linkErr = e; S.pc = null;
      if (S.send && S.send.running) onSendLost(wasOpen);
      render();
    };
    c.fail = fail;
    c.sig = LB.signal("role=phone&code=" + encodeURIComponent(code), async m => {
      c.sigOpened = true;
      try {
        if (m.t === "err") fail(m.e in ERR ? m.e : "lost");
        else if (m.t === "joined") {
          await pc.setLocalDescription(await pc.createOffer());
          c.sig.send({ t: "sdp", d: pc.localDescription });
        } else if (m.t === "sdp") await pc.setRemoteDescription(m.d);
        else if (m.t === "ice") { try { await pc.addIceCandidate(m.d); } catch (e) { /* candidat ignoré */ } }
        else if (m.t === "closed") fail("closed");
      } catch (e) { fail("p2p"); }
    }, () => { if (!c.open) fail(S.link === "connecting" && !c.sigOpened ? "relay" : "lost"); });
    pc.onicecandidate = e => { if (e.candidate) c.sig.send({ t: "ice", d: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed" || pc.connectionState === "closed") fail(c.open ? "lost" : "p2p"); };
    c.timer = setTimeout(() => { if (!c.open) fail("p2p"); }, 25000);
    dc.onopen = async () => {
      c.open = true; clearTimeout(c.timer);
      S.link = "linked"; S.linkErr = "";
      dc.send(JSON.stringify({ t: "hello", v: 1, sid: SID }));
      render();
      S.route = await LB.routeKind(pc);
      render();
    };
    dc.onclose = () => fail("lost");
    dc.onbufferedamountlow = wake;
    dc.onmessage = e => { if (typeof e.data === "string") { try { onPc(c, JSON.parse(e.data)); } catch (x) { console.error(x); } } };
    c.room = async () => {
      while (!c.dead && (c.sent - c.written >= WINDOW || dc.bufferedAmount >= WINDOW)) await new Promise(r => { c.wake = r; setTimeout(r, 1000); });
      if (c.dead) throw new Error("lost");
    };
    c.wakeUp = wake;
  }
  function disconnect() {
    if (!conn) return;
    const c = conn; conn = null; c.dead = true;
    try { c.sig && c.sig.close(); } catch (e) { /* fermé */ }
    try { c.pc.close(); } catch (e) { /* fermé */ }
    if (c.wakeUp) c.wakeUp();
  }
  const SID = LB.rid();

  /* messages du PC */
  function onPc(c, m) {
    if (m.t === "w") { c.written = m.n; c.wakeUp(); return; }
    if (m.t === "ready") {
      S.pc = m;
      if (S.wantSend && canSend()) startSend();
      render();
    } else if (m.t === "skip") {
      if (S.send) S.send.skip.add(m.id);
    } else if (m.t === "ok") {
      const f = S.files.find(x => x.id === m.id);
      if (f) f.st = m.saved ? "saved" : "sent";
      if (S.send) { S.send.ok++; if (m.skipped) S.send.skipped++; if (S.send.okWait) S.send.okWait(); }
    } else if (m.t === "saved") {
      for (const f of S.files) if (f.st === "sent") f.st = "saved";
      if (S.send && S.send.savedWait) S.send.savedWait();
    } else if (m.t === "err") {
      if (S.send) S.send.pcErr = m.e;
      toast(t("Le PC signale une erreur :") + " " + m.e, 6000);
    }
  }
  const canSend = () => S.pc && (S.pc.mode === "dir" || (S.pc.mode === "zip" && S.pc.zipOpen));

  /* ---------- envoi ---------- */
  function askSend() {
    if (!sel().length) return;
    S.wantSend = true;
    if (S.link === "linked" && canSend()) startSend();
    else {
      S.view = "link"; render();
      if (S.link === "error" && S.code) connect(S.code); // connexion perdue pendant le choix des photos : on la reprend
    }
  }

  async function startSend() {
    S.wantSend = false;
    const c = conn;
    if (!c || !c.open) return;
    const todo = sorted().filter(f => f.sel && f.st !== "saved");
    if (!todo.length) { finish(); return; }
    const prev = S.send;
    // reprise du même lot si le PC l'a encore ouvert (ZIP pas fini, connexion revenue)
    const resume = prev && S.pc.bid && prev.bid === S.pc.bid;
    const have = new Set(resume ? S.pc.have || [] : []);
    if (!resume) for (const f of S.files) if (f.st === "sent") f.st = "todo";
    const s = S.send = resume ? prev : {
      bid: LB.rid(), list: todo, total: sum(todo), doneB: 0, sentB: 0, ok: 0, skipped: 0, cur: null, start: Date.now(), t0B: 0, skip: new Set(), compressed: 0,
    };
    s.running = true; s.lost = false; s.pcErr = null; s.speed = s.speed || 0;
    S.view = "send"; render();
    LB.keepAwake(true);
    try {
      c.dc.send(JSON.stringify({ t: "batch", bid: s.bid, n: s.list.length, bytes: s.total }));
      s.doneB = sum(s.list.filter(f => f.st === "saved" || have.has(f.id)));
      let next = null;
      const queue = s.list.filter(f => f.st !== "saved" && !have.has(f.id));
      for (let i = 0; i < queue.length; i++) {
        const f = queue[i];
        s.cur = { f, frac: 0, prep: true };
        tick();
        const p = await (next || prepare(f));
        next = queue[i + 1] ? prepare(queue[i + 1]) : null; // la photo suivante se prépare pendant l'envoi
        if (p.compressed) s.compressed++;
        s.cur.prep = false;
        await c.room();
        c.dc.send(JSON.stringify({ t: "f", id: f.id, name: p.name, size: p.blob.size, date: when(f), mime: p.type }));
        const size = c.chunk || (c.chunk = Math.max(16384, Math.min(+LB.params.get("chunk") || 262144, (c.pc.sctp && c.pc.sctp.maxMessageSize) || CHUNK)));
        const rd = p.blob.stream().getReader();
        let n = 0;
        for (;;) {
          if (s.skip.has(f.id)) { try { await rd.cancel(); } catch (e) { /* déjà fini */ } break; }
          const { value, done } = await rd.read();
          if (done) break;
          for (let o = 0; o < value.length; o += size) {
            await c.room();
            const part = value.slice(o, o + size);
            c.dc.send(part);
            c.sent += part.length; n += part.length; s.sentB += part.length;
            s.cur.frac = n / p.blob.size;
          }
          tick();
        }
        await c.room();
        c.dc.send(JSON.stringify({ t: "e", id: f.id }));
        s.doneB += f.size; s.cur.frac = 0;
        tick();
      }
      c.dc.send(JSON.stringify({ t: "end", bid: s.bid }));
      // attendre que le PC ait tout écrit (et fermé le ZIP)
      await new Promise((res, rej) => {
        const chk = setInterval(() => { if (c.dead) { clearInterval(chk); rej(new Error("lost")); } }, 500);
        s.savedWait = () => { clearInterval(chk); res(); };
      });
      s.running = false;
      LB.keepAwake(false);
      finish();
    } catch (e) {
      s.running = false;
      LB.keepAwake(false);
      if (!c.dead) { console.error(e); toast(t("Erreur :") + " " + e.message, 6000); c.fail("lost"); }
    }
  }

  function onSendLost() {
    const s = S.send;
    s.running = false; s.lost = true;
    LB.keepAwake(false);
    // reconnexion automatique avec le même code (iPhone mis en veille, Wi-Fi qui saute…)
    s.retries = (s.retries || 0) + 1;
    if (s.retries <= 3 && S.code && document.visibilityState === "visible") {
      setTimeout(() => { if (S.send === s && s.lost && !conn) { S.wantSend = true; connect(S.code); } }, 1500);
    }
  }

  function finish() {
    const s = S.send;
    const sent = S.files.filter(f => f.st === "saved" && s && s.list.includes(f));
    const dates = sent.map(when).filter(Boolean).sort((a, b) => a - b);
    S.result = {
      n: sent.length, bytes: sum(sent), skipped: s ? s.skipped : 0, compressed: s ? s.compressed : 0,
      first: dates[0], last: dates[dates.length - 1], mode: S.pc && S.pc.mode, label: S.pc && S.pc.label,
      top: sent.slice().sort((a, b) => b.size - a.size).slice(0, 5),
    };
    S.send = null;
    S.view = "done";
    render();
  }

  /* progression (4 fois par seconde au plus, sans tout redessiner) */
  let tickAt = 0, lastB = 0, lastT = 0;
  const fracNow = s => (s && s.total ? Math.min(1, (s.doneB + (s.cur ? s.cur.f.size * s.cur.frac : 0)) / s.total) : 0);
  function tick() {
    const now = performance.now();
    if (now - tickAt < 250) return;
    tickAt = now;
    const s = S.send;
    if (!s || S.view !== "send") return;
    if (lastT && now - lastT > 900) {
      const v = (s.sentB - lastB) / ((now - lastT) / 1000);
      s.speed = s.speed ? s.speed * 0.7 + v * 0.3 : v;
      lastB = s.sentB; lastT = now;
    } else if (!lastT) { lastB = s.sentB; lastT = now; }
    const cur = s.cur ? s.cur.f.size * s.cur.frac : 0;
    const frac = fracNow(s);
    const el = $("#sendProg");
    if (!el) return;
    el.style.width = (frac * 100).toFixed(1) + "%";
    $("#sendBytes").textContent = bytes(s.doneB + cur);
    $("#sendSpeed").textContent = s.speed > 0 ? bytes(s.speed) + "/s" : "";
    const left = s.speed > 0 ? ((s.total - s.doneB - cur) * (s.sentB / Math.max(1, s.doneB + cur))) / s.speed : NaN;
    $("#sendEta").textContent = eta(left);
    const i = s.cur ? s.list.indexOf(s.cur.f) + 1 : s.list.length;
    $("#sendFile").textContent = t("{i} sur {n}", { i: count(i), n: count(s.list.length) }) + (s.cur ? " · " + s.cur.f.name + (s.cur.prep && S.compress && s.cur.f.kind === "photo" ? " · " + t("compression…") : "") : "");
  }

  /* ---------- rendu ---------- */
  function render() {
    const v = $("#view");
    v.innerHTML = ({ home: vHome, list: vList, link: vLink, send: vSend, done: vDone })[S.view]();
    if (S.view === "list") renderList();
    if (S.view === "link") { const inp = $("#codeIn"); if (inp && !inp.value) inp.value = code6(S.code); }
    if (S.view === "send") { tickAt = 0; tick(); }
  }

  const linkBadge = () => S.link === "linked"
    ? '<div class="linkbar on">' + ic("laptop") + "<span>" + esc(t("PC connecté")) + (S.route === "internet" ? " · " + esc(t("par Internet")) : S.route === "lan" ? " · " + esc(t("même Wi-Fi")) : "") + '</span><button class="link" data-action="unlink">' + esc(t("Déconnecter")) + "</button></div>"
    : "";

  function vHome() {
    return (desktop ? '<div class="note">' + ic("laptop") + "<div>" + esc(t("Vous êtes sur un ordinateur ? Ouvrez la page du PC :")) + ' <a class="link" href="' + esc(LB.pageUrl("pc")) + '">' + esc(PC_URL) + "</a></div></div>" : "") +
      linkBadge() +
      '<section class="hero"><h1 class="h1">' + esc(t("Libérez de la place sur votre iPhone")) + "</h1>" +
      '<p class="muted">' + esc(t("Envoyez vos photos et vidéos sur le PC par le Wi-Fi, en direct, puis supprimez-les de l'iPhone.")) + "</p></section>" +
      '<button class="cta" data-action="pick">' + ic("images") + '<div class="grow"><div class="t">' + esc(t("Choisir des photos et vidéos")) + '</div><div class="s">' + esc(t("Les plus lourdes en premier, vous décidez")) + "</div></div>" + ic("chevron-right") + "</button>" +
      (S.files.length ? '<button class="btn block" data-action="to-list">' + esc(t("Reprendre ma sélection")) + " · " + esc(plural(S.files.length, "fichier", "fichiers")) + "</button>" : "") +
      '<div class="section-title">' + esc(t("Comment ça marche")) + "</div>" +
      '<div class="card"><ol class="steps-list">' +
      "<li><b>" + esc(t("Choisissez")) + "</b><span>" + esc(t("Photos et vidéos, triées par taille ou par date.")) + "</span></li>" +
      "<li><b>" + esc(t("Ouvrez Libera sur le PC")) + '</b><span>' + esc(t("Sur le PC, allez sur")) + ' <span class="mono">' + esc(PC_URL) + "</span> " + esc(t("puis scannez le QR code avec l'appareil photo, ou tapez le code affiché.")) + "</span></li>" +
      "<li><b>" + esc(t("Libérez la place")) + "</b><span>" + esc(t("Une fois sur le PC, supprimez-les dans Photos puis videz « Supprimés récemment ». Libera vous guide.")) + "</span></li>" +
      "</ol></div>" +
      (isIOS && !standalone ? '<div class="note">' + ic("smartphone") + "<div><b>" + esc(t("Gardez Libera sur l'écran d'accueil")) + "</b><br>" + esc(t("Dans Safari, touchez Partager (le carré avec la flèche), puis « Sur l'écran d'accueil ». Gratuit, sans App Store.")) + "</div></div>" : "") +
      '<div class="note">' + ic("shield-check") + "<div>" + esc(t("Vos fichiers ne passent par aucun serveur : ils vont directement de l'iPhone au PC, chiffrés. Sans compte, sans publicité.")) + "</div></div>";
  }

  function vList() {
    const photos = S.files.filter(f => f.kind === "photo").length, videos = S.files.length - photos;
    const chosen = sel(), dates = S.files.map(when).filter(Boolean);
    const span = dates.length ? date(Math.min(...dates)) + " – " + date(Math.max(...dates)) : "";
    const est = estimate(chosen), raw = sum(chosen);
    const anyPhoto = chosen.some(f => f.kind === "photo");
    return linkBadge() +
      '<div class="row list-head"><button class="icon-btn" data-action="home" aria-label="' + esc(t("Retour")) + '">' + ic("chevron-left") + '</button><div class="grow">' +
      '<div class="h2">' + esc([photos ? plural(photos, "photo", "photos") : "", videos ? plural(videos, "vidéo", "vidéos") : ""].filter(Boolean).join(" · ")) + "</div>" +
      '<div class="muted small">' + esc(bytes(sum(S.files))) + (span ? " · " + esc(span) : "") + "</div></div>" +
      '<button class="btn sm" data-action="pick">' + ic("plus") + esc(t("Ajouter")) + "</button></div>" +
      (anyPhoto ? '<div class="card opt"><button class="tile-btn' + (S.compress ? " on" : "") + '" data-action="compress"><span class="check">' + ic("check") + '</span><div class="grow"><div class="name">' + esc(t("Compresser les photos")) + '</div><div class="desc">' + esc(t("2 560 px, qualité 85 : identiques à l'écran, environ deux fois plus légères. Date de prise de vue conservée. Les vidéos partent telles quelles.")) + "</div>" +
        (S.compress ? '<div class="desc"><b>' + esc(t("≈ {a} au lieu de {b}", { a: bytes(est), b: bytes(raw) })) + "</b></div>" : "") + "</div></button>" +
        (S.compress ? '<div class="note warn">' + ic("triangle-alert") + "<div>" + esc(t("Si vous supprimez ensuite les originaux de l'iPhone, il ne restera que la version compressée.")) + "</div></div>" : "") + "</div>" : "") +
      '<div class="seg" role="group" aria-label="' + esc(t("Trier")) + '">' +
      [["size", "Les plus lourdes"], ["new", "Les plus récentes"], ["old", "Les plus anciennes"]].map(([k, l]) => '<button data-action="sort" data-k="' + k + '" class="' + (S.sort === k ? "on" : "") + '">' + esc(t(l)) + "</button>").join("") + "</div>" +
      '<div class="toolbar"><span class="count">' + esc(t("{n} choisis · {size}", { n: count(chosen.length), size: bytes(raw) })) + '</span><button class="tool" data-action="all">' + esc(chosen.length === S.files.length ? t("Tout décocher") : t("Tout cocher")) + "</button></div>" +
      '<div id="plist" class="plist"></div>' +
      '<div class="sticky-foot"><button class="btn primary block" data-action="send"' + (chosen.length ? "" : " disabled") + ">" + ic("send") + esc(t("Envoyer au PC")) + (chosen.length ? " · " + esc(bytes(S.compress ? est : raw)) : "") + "</button></div>";
  }

  function rowHtml(f) {
    const d = when(f);
    return '<button class="prow' + (f.sel ? " on" : "") + '" data-action="toggle" data-id="' + esc(f.id) + '">' +
      '<span class="thumb">' + (f.thumb ? '<img alt="" src="' + f.thumb + '">' : ic(f.kind === "video" ? "video" : "image")) + (f.kind === "video" && f.thumb ? '<span class="vbadge">' + (f.dur ? duration(f.dur) : ic("video")) + "</span>" : "") + "</span>" +
      '<span class="grow"><span class="title ellipsis">' + esc(f.name) + '</span><span class="sub">' + esc(d ? date(d) : t("date inconnue")) + (f.st === "saved" ? " · " + esc(t("déjà sur le PC")) : "") + "</span></span>" +
      '<span class="sz num">' + esc(bytes(f.size)) + '</span><span class="check">' + ic("check") + "</span></button>";
  }

  function renderList() {
    const el = $("#plist");
    if (!el) return;
    el.innerHTML = sorted().map(rowHtml).join("");
    if (io) el.querySelectorAll(".prow").forEach(r => { const f = S.files.find(x => x.id === r.dataset.id); if (f && !f.thumb && !f.thumbTried) io.observe(r); });
  }

  function vLink() {
    const st = S.link;
    const waiting = st === "linked" && !canSend();
    let status = "";
    if (st === "connecting") status = '<div class="status">' + ic("loader-circle", "spin") + esc(t("Connexion au PC…")) + "</div>";
    else if (waiting) status = '<div class="note good">' + ic("circle-check") + "<div><b>" + esc(t("PC connecté.")) + "</b> " + esc(S.pc && S.pc.mode === "zip" ? t("Sur le PC, cliquez sur « Télécharger un ZIP » pour recevoir ce lot.") : t("Sur le PC, choisissez où enregistrer (un dossier ou un ZIP) : l'envoi démarre tout seul.")) + "</div></div>";
    else if (st === "error") status = '<div class="note warn">' + ic("triangle-alert") + "<div>" + esc(t(ERR[S.linkErr] || ERR.lost)) + "</div></div>";
    return '<div class="row"><button class="icon-btn" data-action="' + (S.files.length ? "to-list" : "home") + '" aria-label="' + esc(t("Retour")) + '">' + ic("chevron-left") + "</button></div>" +
      '<h1 class="h1">' + esc(t("Connectez le PC")) + "</h1>" +
      '<div class="step-lbl"><span class="num">1</span>' + esc(t("Sur le PC, ouvrez cette page :")) + "</div>" +
      '<div class="url-box">' + esc(PC_URL) + "</div>" +
      '<div class="step-lbl" style="margin-top:18px"><span class="num">2</span>' + esc(t("Scannez son QR code avec l'appareil photo, ou tapez le code affiché :")) + "</div>" +
      '<input id="codeIn" class="code-in num" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="000 000" aria-label="' + esc(t("Code du PC")) + '"' + (st === "connecting" || st === "linked" ? " disabled" : "") + ">" +
      (st === "linked" ? "" : '<button class="btn primary block" data-action="connect"' + (st === "connecting" ? " disabled" : "") + ">" + esc(t("Connecter")) + "</button>") +
      status +
      '<div class="note">' + ic("wifi") + "<div>" + esc(t("L'iPhone et le PC doivent être sur le même Wi-Fi. Gardez cet écran ouvert pendant l'envoi.")) + "</div></div>";
  }

  function vSend() {
    const s = S.send;
    return '<h1 class="h1">' + esc(s && s.lost ? t("Connexion perdue") : t("Envoi vers le PC")) + "</h1>" +
      '<div class="progress big"><span id="sendProg" style="width:' + (fracNow(s) * 100).toFixed(1) + '%"></span></div>' +
      '<div class="row prog-line"><span class="grow"><b id="sendBytes" class="num"></b> <span class="muted">' + esc(t("sur")) + " " + esc(bytes(s ? s.total : 0)) + '</span></span><span id="sendSpeed" class="num muted"></span></div>' +
      '<div id="sendFile" class="muted small ellipsis"></div><div id="sendEta" class="faint small"></div>' +
      (s && s.lost
        ? '<div class="note warn">' + ic("triangle-alert") + "<div>" + esc(t("L'iPhone s'est mis en veille ou le Wi-Fi a coupé. Ce qui est déjà arrivé sur le PC est gardé : reprenez pour envoyer le reste.")) + "</div></div>" +
          '<button class="btn primary block" data-action="resume">' + ic("refresh-cw") + esc(t("Reprendre l'envoi")) + "</button>"
        : '<div class="note">' + ic("sun") + "<div>" + esc(t("Ne verrouillez pas l'iPhone et ne changez pas d'appli avant la fin : Safari couperait la connexion.")) + "</div></div>" +
          (S.route === "internet" ? '<div class="note warn">' + ic("globe") + "<div>" + esc(t("La connexion passe par Internet (toujours en direct, sans serveur) : vérifiez que l'iPhone est bien sur le Wi-Fi pour ne pas consommer de données mobiles.")) + "</div></div>" : "")) +
      '<button class="btn ghost block" data-action="stop">' + esc(t("Arrêter")) + "</button>";
  }

  function vDone() {
    const r = S.result || { n: 0, bytes: 0 };
    const where = r.mode === "zip" ? t("dans un ZIP, dossier Téléchargements du PC") : r.label ? t("dans le dossier « {name} » du PC", { name: r.label }) : "";
    const range = r.first ? (date(r.first) === date(r.last) ? date(r.first) : t("du {a} au {b}", { a: date(r.first), b: date(r.last) })) : "";
    return '<div class="big-result">' + ic("circle-check") + '<div class="num">' + esc(bytes(r.bytes)) + "</div>" +
      '<div class="muted">' + esc(plural(r.n, "fichier sur le PC", "fichiers sur le PC")) + (where ? " · " + esc(where) : "") + "</div>" +
      (r.skipped ? '<div class="faint small">' + esc(plural(r.skipped, "était déjà sur le PC", "étaient déjà sur le PC")) + "</div>" : "") + "</div>" +
      '<div class="section-title">' + esc(t("Maintenant, libérez la place")) + "</div>" +
      '<div class="note">' + ic("info") + "<div>" + esc(t("Une page web ne peut pas supprimer de photos : Apple ne le permet qu'à l'app Photos. C'est donc à vous de le faire, en deux minutes :")) + "</div></div>" +
      '<div class="card"><ol class="steps-list">' +
      "<li><b>" + esc(t("Vérifiez sur le PC")) + "</b><span>" + esc(t("Ouvrez quelques photos et vidéos pour voir qu'elles sont bien là.")) + " " + esc(t("Les Live Photos arrivent en photo fixe : la partie animée ne sort pas par Safari.")) + "</span></li>" +
      "<li><b>" + esc(t("Supprimez-les dans Photos")) + "</b><span>" + esc(t("Touchez Sélectionner, cochez les photos (glissez le doigt pour en cocher plusieurs), puis la corbeille.")) + (range ? " " + esc(t("Ce qui a été envoyé date {range}.", { range })) : "") + "</span></li>" +
      "<li><b>" + esc(t("Videz « Supprimés récemment »")) + "</b><span>" + esc(t("Dans Photos, descendez jusqu'à Utilitaires › Supprimés récemment › Sélectionner › Tout supprimer. Sans cette étape, rien n'est libéré pendant 30 jours.")) + "</span></li>" +
      "</ol></div>" +
      '<div class="note warn">' + ic("cloud") + "<div>" + esc(t("Avec Photos iCloud activé, supprimer sur l'iPhone supprime aussi d'iCloud et de vos autres appareils. C'est voulu ici : la copie est sur le PC.")) + "</div></div>" +
      (r.top && r.top.length ? '<div class="section-title">' + esc(t("Les plus lourdes envoyées")) + '</div><div class="card tight">' + r.top.map(f => '<div class="kv"><span class="ellipsis">' + esc(f.name) + ' <span class="faint">' + esc(when(f) ? date(when(f)) : "") + '</span></span><b class="num">' + esc(bytes(f.size)) + "</b></div>").join("") + "</div>" : "") +
      '<button class="btn primary block" data-action="again" style="margin-top:12px">' + ic("images") + esc(t("Envoyer d'autres photos")) + "</button>";
  }

  /* ---------- actions ---------- */
  const pick = $("#pick");
  pick.addEventListener("change", () => { const fs = Array.from(pick.files || []); pick.value = ""; if (fs.length) addFiles(fs); });

  document.addEventListener("click", e => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const a = b.dataset.action;
    if (a === "pick") pick.click();
    else if (a === "home") { S.view = "home"; render(); }
    else if (a === "to-list") { S.view = "list"; render(); }
    else if (a === "sort") { S.sort = b.dataset.k; render(); }
    else if (a === "toggle") {
      const f = S.files.find(x => x.id === b.dataset.id);
      if (f) { f.sel = !f.sel; b.classList.toggle("on", f.sel); updateListFoot(); }
    } else if (a === "all") { const on = sel().length !== S.files.length; S.files.forEach(f => { f.sel = on; }); render(); }
    else if (a === "compress") { S.compress = !S.compress; render(); }
    else if (a === "send") askSend();
    else if (a === "connect") {
      const c = ($("#codeIn").value || "").replace(/\D/g, "");
      if (c.length !== 6) { toast(t("Le code a 6 chiffres.")); return; }
      connect(c);
    } else if (a === "unlink") { disconnect(); S.link = "off"; S.pc = null; render(); }
    else if (a === "resume") { if (S.send) S.send.retries = 0; S.wantSend = true; if (conn && conn.open) startSend(); else { S.view = "link"; connect(S.code); } }
    else if (a === "stop") {
      if (confirm(t("Arrêter l'envoi ? Ce qui est déjà sur le PC est gardé."))) {
        const s = S.send; if (s) { s.running = false; s.lost = false; }
        disconnect(); S.link = "off"; S.pc = null; S.send = null; LB.keepAwake(false); S.view = "list"; render();
      }
    } else if (a === "again") {
      S.files = S.files.filter(f => f.st !== "saved"); S.result = null; S.view = S.files.length ? "list" : "home"; render();
      if (!S.files.length) pick.click();
    }
  });
  function updateListFoot() {
    const chosen = sel(), raw = sum(chosen), est = estimate(chosen);
    const cnt = $(".toolbar .count"); if (cnt) cnt.textContent = t("{n} choisis · {size}", { n: count(chosen.length), size: bytes(raw) });
    const btn = $(".sticky-foot .btn"); if (btn) { btn.disabled = !chosen.length; btn.innerHTML = ic("send") + esc(t("Envoyer au PC")) + (chosen.length ? " · " + esc(bytes(S.compress ? est : raw)) : ""); }
    const all = $('[data-action="all"]'); if (all) all.textContent = chosen.length === S.files.length ? t("Tout décocher") : t("Tout cocher");
  }
  document.addEventListener("input", e => {
    if (e.target.id !== "codeIn") return;
    const d = e.target.value.replace(/\D/g, "").slice(0, 6);
    e.target.value = d.length > 3 ? d.slice(0, 3) + " " + d.slice(3) : d;
    if (d.length === 6 && S.link !== "connecting" && S.link !== "linked") connect(d);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (S.send && S.send.running) LB.keepAwake(true);
    if (S.send && S.send.lost && !conn && S.code) { S.wantSend = true; connect(S.code); }
  });
  window.addEventListener("beforeunload", e => { if (S.send && S.send.running) { e.preventDefault(); e.returnValue = ""; } });

  /* code reçu par le QR du PC : …/iphone/#c=482913 */
  function fromHash() {
    const m = /(?:^|[#&])c=(\d{6})/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    S.code = m[1];
    connect(m[1]);
  }
  window.addEventListener("hashchange", fromHash);

  LB.initLang(render);
  fromHash();
  render();
  if ("serviceWorker" in navigator && !LB.local) navigator.serviceWorker.register("sw.js").catch(() => { /* hors ligne indisponible */ });
})();
