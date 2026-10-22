import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeJson } from "./config.mjs";
export class EditorLock {
  constructor(dir, getSettings, now = () => Date.now()) {
    this.file = path.join(dir, "editor-lock.json");
    this.getSettings = getSettings;
    this.now = now;
    this.secret = null;
    this.at = now();
    this.failures = [];
    if (fs.existsSync(this.file)) {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!/^[0-9a-f]{32}$/.test(d.salt) || !/^[0-9a-f]{64}$/.test(d.hash))
        throw Error("편집기 잠금 파일이 손상되었습니다.");
      this.secret = d;
    }
    this.locked = !!this.secret;
  }
  status() {
    const idleMinutes = this.getSettings().security.idleLockMinutes;
    if (
      this.secret &&
      idleMinutes > 0 &&
      this.now() - this.at >= idleMinutes * 60000
    )
      this.locked = true;
    return { configured: !!this.secret, locked: this.locked, idleMinutes };
  }
  touch() {
    this.at = this.now();
  }
  derive(password, salt) {
    return crypto.scryptSync(password, salt, 32).toString("hex");
  }
  verify(password) {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < 60000);
    if (this.failures.length >= 5)
      throw Object.assign(Error("잠시 후 다시 시도하세요."), { status: 429 });
    if (
      typeof password !== "string" ||
      password.length > 256 ||
      !this.secret ||
      !crypto.timingSafeEqual(
        Buffer.from(this.derive(password, this.secret.salt), "hex"),
        Buffer.from(this.secret.hash, "hex"),
      )
    ) {
      this.failures.push(now);
      throw Object.assign(Error("비밀번호를 확인하세요."), { status: 403 });
    }
    this.failures = [];
  }
  configure(password, currentPassword) {
    if (this.secret) this.verify(currentPassword);
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 256
    )
      throw Error("비밀번호는 8~256자여야 합니다.");
    const salt = crypto.randomBytes(16).toString("hex"),
      secret = { salt, hash: this.derive(password, salt) };
    writeJson(this.file, secret);
    this.secret = secret;
    this.locked = false;
    this.touch();
  }
  lock() {
    if (!this.secret) throw Error("먼저 편집기 비밀번호를 설정하세요.");
    this.locked = true;
  }
  unlock(password) {
    this.verify(password);
    this.locked = false;
    this.touch();
  }
  disable(password) {
    this.verify(password);
    fs.rmSync(this.file);
    this.secret = null;
    this.locked = false;
    this.touch();
  }
}
