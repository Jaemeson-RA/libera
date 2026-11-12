/* Libera web — ZIP écrit en flux (rien n'est gardé en mémoire), sans recompression (« stored ») :
 * photos et vidéos sont déjà compressées, le ZIP n'est qu'un emballage. ZIP64 automatique au-delà de 4 Go.
 * Dates : date de prise de vue (heure locale DOS + horodatage Unix 0x5455). Noms en UTF-8.
 *
 *   const z = new ZipStream(bytes => sortie(bytes));
 *   await z.begin("2026-08/IMG_0001.jpg", taille, dateMs); await z.data(u8)…; await z.end();
 *   await z.finish();
 * Une entrée commencée puis abandonnée (connexion perdue) reste dans le flux mais hors du répertoire final :
 * le ZIP reste valide et la ré-émission du même fichier crée une entrée propre. */
(function () {
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(crc, u8) {
    let c = crc ^ 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const MAX32 = 0xffffffff;
  const enc = new TextEncoder();

  class Buf {
    constructor(n) { this.u8 = new Uint8Array(n); this.dv = new DataView(this.u8.buffer); this.p = 0; }
    u16(v) { this.dv.setUint16(this.p, v, true); this.p += 2; return this; }
    u32(v) { this.dv.setUint32(this.p, v >>> 0, true); this.p += 4; return this; }
    u64(v) { this.dv.setUint32(this.p, v % 2 ** 32, true); this.dv.setUint32(this.p + 4, Math.floor(v / 2 ** 32), true); this.p += 8; return this; }
    bytes(b) { this.u8.set(b, this.p); this.p += b.length; return this; }
  }

  function dos(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    if (y < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((Math.min(y, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  class ZipStream {
    constructor(out, opts) {
      this.out = out; this.off = 0; this.entries = []; this.cur = null;
      this.force64 = !!(opts && opts.force64); // tests : force les structures ZIP64 même sur de petits fichiers
    }
    async emit(u8) { this.off += u8.length; await this.out(u8); }

    async begin(path, size, ms) {
      if (this.cur) throw new Error("zip: entry already open");
      const name = enc.encode(path);
      const z64 = this.force64 || size >= MAX32;
      const { time, date } = dos(ms || Date.now());
      const unix = Math.max(0, Math.min(MAX32, Math.floor((ms || Date.now()) / 1000)));
      const extra = 9 + (z64 ? 20 : 0);
      const h = new Buf(30 + name.length + extra);
      h.u32(0x04034b50).u16(z64 ? 45 : 20).u16(0x0808).u16(0).u16(time).u16(date)
        .u32(0).u32(z64 ? MAX32 : 0).u32(z64 ? MAX32 : 0).u16(name.length).u16(extra).bytes(name);
      h.u16(0x5455).u16(5).bytes([1]).u32(unix);
      if (z64) h.u16(0x0001).u16(16).u64(0).u64(0);
      this.cur = { name, size, time, date, unix, z64, off: this.off, crc: 0, n: 0 };
      await this.emit(h.u8);
    }

    async data(u8) {
      const c = this.cur;
      c.crc = crc32(c.crc, u8);
      c.n += u8.length;
      await this.emit(u8);
    }

    async end() {
      const c = this.cur;
      if (!c) return;
      this.cur = null;
      const d = new Buf(c.z64 ? 24 : 16);
      d.u32(0x08074b50).u32(c.crc);
      if (c.z64) d.u64(c.n).u64(c.n); else d.u32(c.n).u32(c.n);
      await this.emit(d.u8);
      this.entries.push(c);
    }

    /* abandon de l'entrée en cours : ses octets restent dans le flux mais elle n'est pas répertoriée */
    drop() { this.cur = null; }

    async finish() {
      if (this.cur) this.drop();
      const cdStart = this.off;
      for (const e of this.entries) {
        const bigSize = this.force64 || e.n >= MAX32, bigOff = this.force64 || e.off >= MAX32;
        const z = (bigSize ? 16 : 0) + (bigOff ? 8 : 0);
        const extra = 9 + (z ? 4 + z : 0);
        const h = new Buf(46 + e.name.length + extra);
        h.u32(0x02014b50).u16(45).u16(e.z64 || z ? 45 : 20).u16(0x0808).u16(0).u16(e.time).u16(e.date)
          .u32(e.crc).u32(bigSize ? MAX32 : e.n).u32(bigSize ? MAX32 : e.n).u16(e.name.length).u16(extra)
          .u16(0).u16(0).u16(0).u32(0).u32(bigOff ? MAX32 : e.off).bytes(e.name);
        h.u16(0x5455).u16(5).bytes([1]).u32(e.unix);
        if (z) { h.u16(0x0001).u16(z); if (bigSize) h.u64(e.n).u64(e.n); if (bigOff) h.u64(e.off); }
        await this.emit(h.u8);
      }
      const cdSize = this.off - cdStart;
      const n = this.entries.length;
      if (this.force64 || n >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32) {
        const rec = this.off;
        const z = new Buf(56 + 20);
        z.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(n).u64(n).u64(cdSize).u64(cdStart);
        z.u32(0x07064b50).u32(0).u64(rec).u32(1);
        await this.emit(z.u8);
      }
      const big = this.force64 || n >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
      const e = new Buf(22);
      e.u32(0x06054b50).u16(0).u16(0).u16(big ? 0xffff : n).u16(big ? 0xffff : n)
        .u32(big ? MAX32 : cdSize).u32(big ? MAX32 : cdStart).u16(0);
      await this.emit(e.u8);
      return this.off;
    }
  }

  window.ZipStream = ZipStream;
  window.crc32 = crc32;
})();
