import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function readPrivateJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 8 * 1024 * 1024 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error("안전한 보안 저장소가 필요합니다.");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
export function writePrivateJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink())
    throw Error("안전한 보안 저장소가 필요합니다.");
  if (
    fs.existsSync(file) &&
    (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
  )
    throw Error("안전한 보안 파일이 필요합니다.");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function checkPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 256
  )
    throw Error("암호는 8~256자여야 합니다.");
  return password;
}
export function hashSecret(value, salt) {
  return crypto.scryptSync(value, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
export function verifier(value) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashSecret(value, salt).toString("hex") };
}
export function matches(value, record) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !record ||
    !/^[a-f0-9]{32}$/.test(record.salt) ||
    !/^[a-f0-9]{64}$/.test(record.hash)
  )
    return false;
  return crypto.timingSafeEqual(
    hashSecret(value, record.salt),
    Buffer.from(record.hash, "hex"),
  );
}
export function newRecoveryKey() {
  return crypto
    .randomBytes(24)
    .toString("hex")
    .toUpperCase()
    .match(/.{1,6}/g)
    .join("-");
}
export function normalizeRecoveryKey(key) {
  if (typeof key !== "string" || key.length > 128) return "";
  const value = key.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-F0-9]{48}$/.test(value) ? value : "";
}
export class AttemptLimiter {
  constructor(now = Date.now) {
    this.now = now;
    this.failed = [];
  }
  check() {
    this.failed = this.failed.filter((at) => this.now() - at < 60000);
    if (this.failed.length >= 5)
      throw Object.assign(
        Error("시도가 너무 많습니다. 1분 후 다시 시도하세요."),
        { status: 429 },
      );
  }
  fail(message = "인증 정보를 확인하세요.") {
    this.failed.push(this.now());
    throw Object.assign(Error(message), { status: 403 });
  }
  clear() {
    this.failed = [];
  }
}
