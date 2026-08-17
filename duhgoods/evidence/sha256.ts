/**
 * Pure-JS SHA-256 implementation.
 * Works in Node.js (tests, main process) and browser renderer without any
 * native module dependency.
 *
 * Implements FIPS PUB 180-4, §6.2.
 */

// SHA-256 round constants (first 32 bits of fractional parts of cube roots of first 64 primes)
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Initial hash values (first 32 bits of fractional parts of square roots of first 8 primes)
const H_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Computes SHA-256 of a UTF-8 string or raw bytes.
 * Returns lowercase hex digest (64 characters).
 */
export function sha256hex(input: string | Uint8Array): string {
  // Convert to bytes
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    const enc = new TextEncoder();
    bytes = enc.encode(input);
  } else {
    // Uint8Array or Buffer (Buffer extends Uint8Array in Node.js)
    bytes = input;
  }

  const bitLen = bytes.length * 8;

  // Pre-processing: padding
  // Message length in bytes → padded to 512-bit (64-byte) boundary
  // Pad: append 0x80, then zeros, then 64-bit big-endian bit length
  const padLen = bytes.length % 64 < 56
    ? 64 - (bytes.length % 64)
    : 128 - (bytes.length % 64);
  const padded = new Uint8Array(bytes.length + padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // Write 64-bit big-endian length (JS numbers are safe up to 2^53; use two 32-bit words)
  const lenHi = Math.floor(bitLen / 0x100000000) >>> 0;
  const lenLo = (bitLen >>> 0) >>> 0;
  const v = new DataView(padded.buffer, padded.byteOffset);
  v.setUint32(padded.length - 8, lenHi, false);
  v.setUint32(padded.length - 4, lenLo, false);

  // Process 512-bit blocks
  const h = new Uint32Array(H_INIT);
  const w = new Uint32Array(64);

  for (let blk = 0; blk < padded.length; blk += 64) {
    // Prepare message schedule
    for (let i = 0; i < 16; i++) {
      w[i] = v.getUint32(blk + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    // Compression
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  // Produce hex digest
  return Array.from(h)
    .map((x) => x.toString(16).padStart(8, '0'))
    .join('');
}
