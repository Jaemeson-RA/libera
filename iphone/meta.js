/* Libera web — métadonnées des photos et vidéos, lues dans le navigateur (rien n'est envoyé).
 *  - JPEG : date de prise de vue EXIF (DateTimeOriginal + décalage horaire) et segment EXIF brut à recopier ;
 *  - MOV / MP4 : date « com.apple.quicktime.creationdate » (sinon mvhd) ;
 *  - exifForCopy() : EXIF de l'original, orientation remise à 1 (l'image recompressée est déjà tournée). */
(function () {
  const rd = (file, off, len) => file.slice(off, Math.min(file.size, off + len)).arrayBuffer().then(b => new DataView(b));
  const str = (dv, off, len) => { let s = ""; for (let i = 0; i < len && off + i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(off + i)); return s; };

  const isJpeg = f => /jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name);
  const isVideo = f => /^video\//.test(f.type) || /\.(mov|mp4|m4v|3gp)$/i.test(f.name);

  /* ---------- JPEG / EXIF ---------- */
  // renvoie { app1: [début, fin] dans le fichier, tiff: début du TIFF } ou null
  function findApp1(dv) {
    if (dv.byteLength < 4 || dv.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 <= dv.byteLength) {
      if (dv.getUint8(p) !== 0xff) return null;
      const m = dv.getUint8(p + 1);
      if (m === 0xda || m === 0xd9) return null;
      const len = dv.getUint16(p + 2);
      if (m === 0xe1 && str(dv, p + 4, 6) === "Exif\0\0") return { start: p, end: p + 2 + len, tiff: p + 10 };
      p += 2 + len;
    }
    return null;
  }

  function readIfd(dv, tiff, off, le) {
    const out = {};
    if (tiff + off + 2 > dv.byteLength) return out;
    const n = dv.getUint16(tiff + off, le);
    for (let i = 0; i < n; i++) {
      const e = tiff + off + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), cnt = dv.getUint32(e + 4, le);
      let val;
      if (type === 2) { // ASCII
        const at = cnt <= 4 ? e + 8 : tiff + dv.getUint32(e + 8, le);
        val = str(dv, at, cnt).replace(/\0+$/, "");
      } else if (type === 3) val = dv.getUint16(e + 8, le);
      else if (type === 4) val = dv.getUint32(e + 8, le);
      out[tag] = { val, pos: e, type };
    }
    return out;
  }

  // « 2026:08:14 18:22:31 » (+ « -03:00 ») -> ms
  function exifTime(s, off) {
    const m = /^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s || "");
    if (!m || m[1] === "0000") return null;
    if (off && /^[+-]\d\d:\d\d$/.test(off)) {
      const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`);
      if (!isNaN(ms)) return ms;
    }
    return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  function parseExif(dv) {
    const a = findApp1(dv);
    if (!a) return null;
    const tf = a.tiff;
    const le = str(dv, tf, 2) === "II";
    if (dv.getUint16(tf + 2, le) !== 42) return null;
    const ifd0 = readIfd(dv, tf, dv.getUint32(tf + 4, le), le);
    let exif = {};
    if (ifd0[0x8769]) exif = readIfd(dv, tf, ifd0[0x8769].val, le);
    const orig = exif[0x9003] && exifTime(exif[0x9003].val, exif[0x9011] && exif[0x9011].val);
    const plain = ifd0[0x0132] && exifTime(ifd0[0x0132].val, exif[0x9010] && exif[0x9010].val);
    return { date: orig || plain || null, app1: a, le, orient: ifd0[0x0112] ? ifd0[0x0112].val : 1, orientPos: ifd0[0x0112] ? ifd0[0x0112].pos : -1 };
  }

  /* segment APP1 de l'original, prêt à être inséré dans le JPEG recompressé (orientation = 1) */
  async function exifForCopy(file) {
    if (!isJpeg(file)) return null;
    const dv = await rd(file, 0, 256 * 1024);
    const x = parseExif(dv);
    if (!x) return null;
    const seg = new Uint8Array(dv.buffer.slice(x.app1.start, x.app1.end));
    if (seg.length !== x.app1.end - x.app1.start) return null; // EXIF plus long que la lecture : on n'y touche pas
    if (x.orientPos >= 0) new DataView(seg.buffer).setUint16(x.orientPos - x.app1.start + 8, 1, x.le);
    return seg;
  }

  /* insère un segment APP1 juste après SOI (et retire le JFIF du canvas, inutile avec l'EXIF) */
  async function withExif(jpegBlob, app1) {
    if (!app1) return jpegBlob;
    const buf = new Uint8Array(await jpegBlob.arrayBuffer());
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return jpegBlob;
    let p = 2;
    if (buf[2] === 0xff && buf[3] === 0xe0) p = 4 + ((buf[4] << 8) | buf[5]);
    return new Blob([buf.subarray(0, 2), app1, buf.subarray(p)], { type: "image/jpeg" });
  }

  /* ---------- MOV / MP4 ---------- */
  const QT_EPOCH = 2082844800; // secondes entre 1904 et 1970

  function box(dv, p) {
    let size = dv.getUint32(p), hdr = 8;
    const type = str(dv, p + 4, 4);
    if (size === 1 && p + 16 <= dv.byteLength) { size = dv.getUint32(p + 8) * 2 ** 32 + dv.getUint32(p + 12); hdr = 16; }
    return { size, type, hdr };
  }

  // parcourt les boîtes enfants d'une boîte déjà lue en mémoire
  function children(dv, start, end, cb) {
    let p = start;
    while (p + 8 <= end) {
      const b = box(dv, p);
      if (b.size < 8) break;
      cb(b.type, p + b.hdr, Math.min(end, p + b.size));
      p += b.size;
    }
  }

  function parseMeta(dv, start, end) {
    // QuickTime : « meta » sans version ; ISO : 4 octets de version avant les enfants
    if (start + 8 <= end && str(dv, start + 4, 4) !== "hdlr" && str(dv, start + 8, 4) === "hdlr") start += 4;
    const keys = [];
    let found = null;
    children(dv, start, end, (type, s, e) => {
      if (type === "keys") {
        const n = dv.getUint32(s + 4);
        let p = s + 8;
        for (let i = 0; i < n && p + 8 <= e; i++) {
          const sz = dv.getUint32(p);
          keys.push(str(dv, p + 8, sz - 8));
          p += sz;
        }
      } else if (type === "ilst") {
        children(dv, s, e, (idx, is, ie) => {
          const k = keys[(dv.getUint32(is - 4)) - 1];
          if (k !== "com.apple.quicktime.creationdate") return;
          children(dv, is, ie, (dt, ds, de) => { if (dt === "data") found = str(dv, ds + 8, de - ds - 8); });
        });
      }
    });
    if (!found) return null;
    const ms = Date.parse(found.trim().replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
    return isNaN(ms) ? null : ms;
  }

  async function videoDate(file) {
    let off = 0;
    for (let guard = 0; guard < 64 && off + 8 <= file.size; guard++) {
      const h = await rd(file, off, 16);
      const b = box(h, 0);
      const size = b.size === 0 ? file.size - off : b.size;
      if (size < 8) return null;
      if (b.type === "moov") {
        let creation = null, meta = null, p = off + b.hdr;
        const end = off + size;
        for (let g = 0; g < 256 && p + 8 <= end; g++) {
          const ch = await rd(file, p, 16);
          const c = box(ch, 0);
          if (c.size < 8) break;
          if (c.type === "mvhd") {
            const d = await rd(file, p + c.hdr, 12);
            const secs = d.getUint8(0) === 1 ? d.getUint32(4) * 2 ** 32 + d.getUint32(8) : d.getUint32(4);
            if (secs > QT_EPOCH + 946684800) creation = (secs - QT_EPOCH) * 1000; // après 2000 : sinon valeur vide
          } else if (c.type === "meta" && c.size < 1e6) {
            const d = await rd(file, p, c.size);
            meta = parseMeta(d, c.hdr, c.size);
          }
          p += c.size;
        }
        return meta || creation;
      }
      off += size;
    }
    return null;
  }

  /* date de prise de vue si on la trouve, sinon null (l'appelant retombe sur lastModified) */
  async function captureDate(file) {
    try {
      if (isJpeg(file)) { const x = parseExif(await rd(file, 0, 256 * 1024)); return x && x.date; }
      if (isVideo(file)) return await videoDate(file);
    } catch (e) { /* fichier illisible : pas de date */ }
    return null;
  }

  window.Meta = { captureDate, exifForCopy, withExif, isJpeg, isVideo };
})();
