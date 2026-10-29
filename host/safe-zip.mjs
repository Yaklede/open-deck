import { deflateRawSync, inflateRawSync } from "node:zlib";
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function safeArchivePath(value) {
  const name = String(value).replaceAll("\\", "/");
  if (
    !name ||
    name.length > 1024 ||
    /[\x00-\x1f:]/.test(name) ||
    name.startsWith("/") ||
    name
      .split("/")
      .some((s, i, a) => s === "." || s === ".." || (!s && i !== a.length - 1))
  )
    throw Error("Archive contains an unsafe path.");
  return name;
}
export function readZip(
  input,
  {
    maxBytes = 192 * 1024 * 1024,
    maxEntryBytes = 64 * 1024 * 1024,
    maxEntries = 20000,
    maxArchiveBytes = 192 * 1024 * 1024,
  } = {},
) {
  const b = Buffer.from(input);
  if (b.length < 22 || b.length > maxArchiveBytes)
    throw Error("ZIP size exceeds the supported limit.");
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (
      b.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + b.readUInt16LE(i + 20) === b.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw Error("ZIP end record is missing.");
  const count = b.readUInt16LE(end + 10),
    start = b.readUInt32LE(end + 16),
    size = b.readUInt32LE(end + 12);
  if (
    b.readUInt16LE(end + 4) ||
    b.readUInt16LE(end + 6) ||
    b.readUInt16LE(end + 8) !== count ||
    count === 65535 ||
    count > maxEntries ||
    start + size !== end
  )
    throw Error("Split/ZIP64 or invalid ZIP directory is unsupported.");
  const entries = new Map(),
    names = new Set(),
    ranges = [];
  let p = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || b.readUInt32LE(p) !== 0x02014b50)
      throw Error("Invalid ZIP directory entry.");
    const flags = b.readUInt16LE(p + 8),
      method = b.readUInt16LE(p + 10),
      crc = b.readUInt32LE(p + 16),
      compressed = b.readUInt32LE(p + 20),
      length = b.readUInt32LE(p + 24),
      nl = b.readUInt16LE(p + 28),
      xl = b.readUInt16LE(p + 30),
      cl = b.readUInt16LE(p + 32),
      offset = b.readUInt32LE(p + 42),
      mode = b.readUInt32LE(p + 38) >>> 16;
    if (
      p + 46 + nl + xl + cl > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      length === 0xffffffff ||
      compressed === 0xffffffff ||
      ![0, 0x8000, 0x4000].includes(mode & 0xf000) ||
      b.readUInt16LE(p + 34)
    )
      throw Error(
        "Encrypted ZIP, symlinks or unsupported ZIP entries are rejected.",
      );
    const nameBytes = b.subarray(p + 46, p + 46 + nl);
    if (!(flags & 0x800) && nameBytes.some((v) => v > 127))
      throw Error("Non-UTF-8 ZIP names are unsupported.");
    const name = safeArchivePath(
      new TextDecoder("utf-8", { fatal: true }).decode(nameBytes),
    );
    if (names.has(name.toLowerCase()))
      throw Error("Duplicate ZIP paths are rejected.");
    names.add(name.toLowerCase());
    total += length;
    if (length > maxEntryBytes || total > maxBytes)
      throw Error("ZIP expanded size exceeds the supported limit.");
    if (
      offset + 30 > start ||
      b.readUInt32LE(offset) !== 0x04034b50 ||
      b.readUInt16LE(offset + 6) !== flags ||
      b.readUInt16LE(offset + 8) !== method
    )
      throw Error("ZIP local header does not match its directory.");
    const ln = b.readUInt16LE(offset + 26),
      lx = b.readUInt16LE(offset + 28),
      data = offset + 30 + ln + lx;
    if (
      !b.subarray(offset + 30, offset + 30 + ln).equals(nameBytes) ||
      data + compressed > start
    )
      throw Error("ZIP local bounds are invalid.");
    ranges.push([offset, data + compressed]);
    const packed = b.subarray(data, data + compressed),
      bytes =
        method === 0
          ? Buffer.from(packed)
          : inflateRawSync(packed, { maxOutputLength: Math.max(1, length) });
    if (bytes.length !== length || crc32(bytes) !== crc)
      throw Error("ZIP CRC or size verification failed.");
    if (name.endsWith("/") && length)
      throw Error("ZIP directory contains file data.");
    entries.set(name, { bytes, mode, directory: name.endsWith("/") });
    p += 46 + nl + xl + cl;
  }
  if (p !== end) throw Error("Unexpected ZIP directory data.");
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i][0] < ranges[i - 1][1])
      throw Error("Overlapping ZIP entries are rejected.");
  return entries;
}
export function writeZip(files, { compress = true } = {}) {
  const items = files instanceof Map ? [...files] : Object.entries(files),
    local = [],
    central = [];
  let offset = 0,
    total = 0;
  const names = new Set();
  if (items.length > 20000) throw Error("Too many ZIP entries.");
  for (const [raw, value] of items) {
    const name = safeArchivePath(raw);
    if (names.has(name.toLowerCase())) throw Error("Duplicate ZIP path.");
    names.add(name.toLowerCase());
    const bytes = Buffer.from(value?.bytes ?? value),
      mode = value?.mode ?? 0o100600,
      nb = Buffer.from(name),
      packed = compress ? deflateRawSync(bytes) : bytes,
      method = compress ? 8 : 0,
      crc = crc32(bytes);
    total += bytes.length;
    if (total > 192 * 1024 * 1024) throw Error("ZIP content is too large.");
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(packed.length, 18);
    h.writeUInt32LE(bytes.length, 22);
    h.writeUInt16LE(nb.length, 26);
    local.push(h, nb, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(bytes.length, 24);
    c.writeUInt16LE(nb.length, 28);
    c.writeUInt32LE((mode << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, nb);
    offset += h.length + nb.length + packed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
