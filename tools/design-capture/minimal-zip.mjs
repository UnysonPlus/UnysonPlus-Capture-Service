// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Minimal dependency-free ZIP writer (STORE method, no compression). Produces a
// standard .zip that WordPress's unzip_file() reads — enough to assemble a Convert
// bundle from the capture artifacts without pulling in a zip dependency.
import { Buffer } from 'buffer';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * @param {{name:string, data:(Buffer|string)}[]} files
 * @returns {Buffer} the .zip bytes
 */
export function makeZip(files) {
  const entries = files.map((f) => ({
    name: Buffer.from(f.name),
    data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data),
  }));

  const local = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const crc = crc32(e.data);
    const size = e.data.length;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4);         // version needed
    lfh.writeUInt16LE(0, 6);          // flags
    lfh.writeUInt16LE(0, 8);          // method 0 = store
    lfh.writeUInt16LE(0, 10);         // mod time
    lfh.writeUInt16LE(0x21, 12);      // mod date (1980-01-01-ish; fixed for determinism)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);      // compressed size
    lfh.writeUInt32LE(size, 22);      // uncompressed size
    lfh.writeUInt16LE(e.name.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra length
    local.push(lfh, e.name, e.data);

    const cdr = Buffer.alloc(46);
    cdr.writeUInt32LE(0x02014b50, 0); // central directory signature
    cdr.writeUInt16LE(20, 4);         // version made by
    cdr.writeUInt16LE(20, 6);         // version needed
    cdr.writeUInt16LE(0, 8);
    cdr.writeUInt16LE(0, 10);
    cdr.writeUInt16LE(0, 12);
    cdr.writeUInt16LE(0x21, 14);
    cdr.writeUInt32LE(crc, 16);
    cdr.writeUInt32LE(size, 20);
    cdr.writeUInt32LE(size, 24);
    cdr.writeUInt16LE(e.name.length, 28);
    cdr.writeUInt16LE(0, 30);         // extra
    cdr.writeUInt16LE(0, 32);         // comment
    cdr.writeUInt16LE(0, 34);         // disk number
    cdr.writeUInt16LE(0, 36);         // internal attrs
    cdr.writeUInt32LE(0, 38);         // external attrs
    cdr.writeUInt32LE(offset, 42);    // offset of local header
    central.push(cdr, e.name);

    offset += lfh.length + e.name.length + e.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);  // end of central directory signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);     // central dir offset
  eocd.writeUInt16LE(0, 20);          // comment length

  return Buffer.concat([...local, centralBuf, eocd]);
}
