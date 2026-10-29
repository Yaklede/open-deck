// Interoperable with Macro Deck 3 PortableArchiveCrypto / BackupPayloadCrypto.
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const derivePassword = promisify(pbkdf2);
const hkdf = (key, salt, info, length) =>
  Buffer.from(hkdfSync("sha256", key, salt, Buffer.from(info), length));
const decode64 = (value, length) => {
  if (typeof value !== "string" || !/[A-Za-z0-9+/=]+/.test(value))
    throw Error("Invalid encryption parameters.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length) throw Error("Invalid encryption parameters.");
  return bytes;
};
function seal(key, nonce, bytes, aad) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { encrypted, tag: cipher.getAuthTag() };
}
function open(key, nonce, bytes, tag, aad) {
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, nonce);
    if (aad) cipher.setAAD(aad);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
  } catch {
    throw Error(
      "Archive authentication failed. Check the password or recovery key.",
    );
  }
}
export function portableEncryption() {
  return {
    cipher: "AES-256-GCM",
    kdf: {
      id: "PBKDF2-HMAC-SHA256",
      iterations: 600000,
      salt: randomBytes(16).toString("base64"),
    },
  };
}
async function passwordKey(password, encryption) {
  if (typeof password !== "string" || !password || password.length > 1024)
    throw Error("This archive needs its password.");
  if (
    encryption?.cipher !== "AES-256-GCM" ||
    encryption.kdf?.id !== "PBKDF2-HMAC-SHA256" ||
    !Number.isInteger(encryption.kdf.iterations) ||
    encryption.kdf.iterations < 100000 ||
    encryption.kdf.iterations > 10000000
  )
    throw Error("Unsupported portable archive encryption.");
  return derivePassword(
    password,
    decode64(encryption.kdf.salt, 16),
    encryption.kdf.iterations,
    32,
    "sha256",
  );
}
export async function encryptPortable(
  bytes,
  password,
  manifestBytes,
  encryption,
) {
  if (password.length < 8)
    throw Error("Use a password with at least 8 characters.");
  const kek = await passwordKey(password, encryption),
    key = randomBytes(32),
    wrapNonce = randomBytes(12),
    payloadNonce = randomBytes(12);
  try {
    const wrapped = seal(kek, wrapNonce, key, manifestBytes),
      payload = seal(key, payloadNonce, bytes);
    return Buffer.concat([
      Buffer.from("MDPE"),
      wrapNonce,
      wrapped.encrypted,
      wrapped.tag,
      payloadNonce,
      payload.tag,
      payload.encrypted,
    ]);
  } finally {
    kek.fill(0);
    key.fill(0);
  }
}
export async function decryptPortable(
  bytes,
  password,
  manifestBytes,
  encryption,
) {
  if (bytes.length < 92 || bytes.toString("ascii", 0, 4) !== "MDPE")
    throw Error("Invalid encrypted portable payload.");
  const kek = await passwordKey(password, encryption);
  let key;
  try {
    key = open(
      kek,
      bytes.subarray(4, 16),
      bytes.subarray(16, 48),
      bytes.subarray(48, 64),
      manifestBytes,
    );
    return open(
      key,
      bytes.subarray(64, 76),
      bytes.subarray(92),
      bytes.subarray(76, 92),
    );
  } finally {
    kek.fill(0);
    key?.fill(0);
  }
}
export function parseRecoveryKey(value) {
  if (typeof value !== "string" || value.length > 1024)
    throw Error("Enter the Macro Deck recovery key.");
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let text = value
    .toUpperCase()
    .replaceAll("O", "0")
    .replace(/[IL]/g, "1")
    .split("")
    .filter((c) => alphabet.includes(c))
    .join("");
  if (text.length === 60 && text.startsWith("MDBK1")) text = text.slice(5);
  if (text.length !== 55) throw Error("Invalid Macro Deck recovery key.");
  let bits = 0,
    acc = 0;
  const values = [];
  for (const ch of text) {
    acc = (acc << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      values.push((acc >> bits) & 255);
    }
  }
  if (values.length !== 34 || acc & ((1 << bits) - 1))
    throw Error("Invalid Macro Deck recovery key.");
  const bytes = Buffer.from(values),
    key = bytes.subarray(0, 32),
    checksum = hkdf(key, Buffer.alloc(0), "MacroDeck.Backup.v1.checksum", 2);
  if (!timingSafeEqual(checksum, bytes.subarray(32)))
    throw Error("Macro Deck recovery key checksum failed.");
  return Buffer.from(key);
}
export function decryptBackup(bytes, recoveryKey, manifestBytes, manifest) {
  if (
    manifest?.encryption?.version !== 1 ||
    manifest.encryption.cipher !== "AES-256-GCM-STREAM" ||
    manifest.encryption.kdf !== "HKDF-SHA256" ||
    bytes.length < 105 ||
    bytes.toString("ascii", 0, 4) !== "MDBK" ||
    bytes[4] !== 1
  )
    throw Error("Unsupported Macro Deck backup encryption.");
  const log2 = bytes[88];
  if (log2 < 16 || log2 > 24) throw Error("Invalid backup chunk size.");
  const recovery = parseRecoveryKey(recoveryKey),
    kek = hkdf(recovery, bytes.subarray(5, 21), "MacroDeck.Backup.v1.kek", 32);
  let key;
  try {
    if (
      manifest.recoveryKeyId &&
      hkdf(recovery, Buffer.alloc(0), "MacroDeck.Backup.v1.keyid", 16).toString(
        "hex",
      ) !== manifest.recoveryKeyId.toLowerCase()
    )
      throw Error("This recovery key belongs to a different backup.");
    key = open(
      kek,
      bytes.subarray(21, 33),
      bytes.subarray(33, 65),
      bytes.subarray(65, 81),
      manifestBytes,
    );
    const header = bytes.subarray(0, 89),
      size = 2 ** log2,
      chunks = [];
    let offset = 89,
      index = 0,
      total = 0;
    while (offset < bytes.length) {
      const remaining = bytes.length - offset;
      if (remaining < 16) throw Error("Truncated backup payload.");
      const final = remaining <= size + 16,
        length = final ? remaining - 16 : size,
        nonce = Buffer.alloc(12);
      bytes.copy(nonce, 0, 81, 88);
      nonce.writeUInt32BE(index++, 7);
      nonce[11] = final ? 1 : 0;
      const chunk = open(
        key,
        nonce,
        bytes.subarray(offset, offset + length),
        bytes.subarray(offset + length, offset + length + 16),
        header,
      );
      total += chunk.length;
      if (total > 192 * 1024 * 1024)
        throw Error("Backup content is too large.");
      chunks.push(chunk);
      offset += length + 16;
    }
    return Buffer.concat(chunks);
  } finally {
    recovery.fill(0);
    kek.fill(0);
    key?.fill(0);
  }
}
