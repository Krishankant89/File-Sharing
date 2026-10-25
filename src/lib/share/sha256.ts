const K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

function rotr(x: number, n: number) {
  return (x >>> n) | (x << (32 - n));
}

/** Incremental SHA-256 so a 10 GB send never has to sit in one buffer. */
export class Sha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private bytes = 0;

  update(data: Uint8Array) {
    if (data.length === 0) return;
    this.bytes += data.length;
    let offset = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      offset = take;
      if (this.bufLen === 64) {
        this.compress(this.buf);
        this.bufLen = 0;
      }
    }
    while (offset + 64 <= data.length) {
      this.compress(data.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < data.length) {
      this.buf.set(data.subarray(offset), 0);
      this.bufLen = data.length - offset;
    }
  }

  hex(): string {
    const copy = this.clone();
    const bitLen = copy.bytes * 8;
    copy.update(Uint8Array.of(0x80));
    const zeros = (64 - ((this.bytes + 1 + 8) % 64)) % 64;
    if (zeros) copy.update(new Uint8Array(zeros));
    const len = new Uint8Array(8);
    const view = new DataView(len.buffer);
    view.setUint32(0, Math.floor(bitLen / 4294967296));
    view.setUint32(4, bitLen >>> 0);
    copy.update(len);
    const out = new Uint8Array(32);
    const words = [copy.h0, copy.h1, copy.h2, copy.h3, copy.h4, copy.h5, copy.h6, copy.h7];
    words.forEach((word, i) => {
      out[i * 4] = word >>> 24;
      out[i * 4 + 1] = word >>> 16;
      out[i * 4 + 2] = word >>> 8;
      out[i * 4 + 3] = word;
    });
    return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private clone(): Sha256 {
    const next = new Sha256();
    next.h0 = this.h0;
    next.h1 = this.h1;
    next.h2 = this.h2;
    next.h3 = this.h3;
    next.h4 = this.h4;
    next.h5 = this.h5;
    next.h6 = this.h6;
    next.h7 = this.h7;
    next.buf = new Uint8Array(this.buf);
    next.bufLen = this.bufLen;
    next.bytes = this.bytes;
    return next;
  }

  private compress(block: Uint8Array) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) {
      w[i] =
        ((block[i * 4] << 24) |
          (block[i * 4 + 1] << 16) |
          (block[i * 4 + 2] << 8) |
          block[i * 4 + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }
}
