import path from "node:path";
import crypto from "node:crypto";
import {
  readPrivateJson,
  writePrivateJson,
  checkPassword,
  verifier,
  matches,
  newRecoveryKey,
  normalizeRecoveryKey,
  AttemptLimiter,
} from "./security-storage.mjs";

const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const fail = () => {
  throw Object.assign(Error("관리자 로그인이 필요합니다."), {
    status: 401,
    code: "ACCOUNT_LOGIN_REQUIRED",
  });
};
function username(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 80 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error("사용자명은 1~80자로 입력하세요.");
  return value.trim();
}
function sessionHours(value = 24) {
  if (!Number.isInteger(value) || value < 1 || value > 720)
    throw Error("로그인 유지 시간은 1~720시간이어야 합니다.");
  return value;
}

export class AccountManager {
  constructor(dir, now = Date.now) {
    this.file = path.join(dir, "account.json");
    this.now = now;
    this.pending = null;
    this.data = readPrivateJson(this.file);
    if (
      this.data &&
      (this.data.version !== 1 ||
        !this.data.password ||
        !Array.isArray(this.data.sessions))
    )
      throw Error("관리자 계정 파일을 확인하세요.");
    this.limiter = new AttemptLimiter(now);
  }
  save() {
    writePrivateJson(this.file, this.data);
  }
  clean() {
    if (!this.data) return;
    const count = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(
      (s) => s.expiresAt > this.now(),
    );
    if (count !== this.data.sessions.length) this.save();
  }
  authenticate(token, { touch = true } = {}) {
    if (!this.data) return true;
    this.clean();
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return false;
    const hash = digest(token),
      session = this.data.sessions.find((s) => s.tokenHash === hash);
    if (!session) return false;
    if (touch && this.now() - session.lastSeenAt >= 60000) {
      session.lastSeenAt = this.now();
      this.save();
    }
    return true;
  }
  require(token) {
    if (!this.data || !this.authenticate(token)) fail();
  }
  verify(password) {
    this.limiter.check();
    if (!matches(password, this.data?.password)) this.limiter.fail();
    this.limiter.clear();
  }
  status(token) {
    const authenticated =
      !!this.data && this.authenticate(token, { touch: false });
    return {
      configured: !!this.data,
      authenticated,
      username: authenticated ? this.data.username : null,
      sessionHours: this.data?.sessionHours || 24,
      recoveryConfigured: !!this.data?.recovery,
      recoveryCreatedAt: this.data?.recovery?.createdAt || null,
      recoveryPending: !!this.pending,
      recoveryState: this.pending
        ? "pending"
        : this.data?.recovery
          ? "active"
          : this.data?.recoveryState || "missing",
    };
  }
  issue(name = "Open Deck editor") {
    this.clean();
    const token = crypto.randomBytes(32).toString("hex"),
      now = this.now();
    const session = {
      id: crypto.randomUUID(),
      tokenHash: digest(token),
      name: String(name || "Open Deck editor")
        .replace(/[\x00-\x1f]/g, "")
        .slice(0, 100),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.data.sessionHours * 3600000,
    };
    this.data.sessions = [...this.data.sessions.slice(-31), session];
    this.save();
    return {
      ...this.status(token),
      sessionToken: token,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }
  setup({
    username: name,
    password,
    sessionHours: hours = 24,
    name: deviceName,
  }) {
    if (this.data) throw Error("관리자 계정이 이미 있습니다.");
    this.data = {
      version: 1,
      username: username(name),
      password: verifier(checkPassword(password)),
      sessionHours: sessionHours(hours),
      createdAt: this.now(),
      recovery: null,
      sessions: [],
    };
    return this.issue(deviceName);
  }
  login({ username: name, password, name: deviceName }) {
    this.limiter.check();
    // Password verification still runs for a wrong username to avoid a cheap username oracle.
    const validPassword = matches(password, this.data?.password);
    if (
      !this.data ||
      typeof name !== "string" ||
      name.trim() !== this.data.username ||
      !validPassword
    )
      this.limiter.fail();
    this.limiter.clear();
    return this.issue(deviceName);
  }
  sessions(token) {
    this.require(token);
    const hash = digest(token);
    return this.data.sessions
      .map(({ tokenHash, ...s }) => ({ ...s, current: tokenHash === hash }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
  update(
    token,
    { currentPassword, username: name, password, sessionHours: hours },
  ) {
    this.require(token);
    this.verify(currentPassword);
    const candidate = { ...this.data };
    if (name !== undefined) candidate.username = username(name);
    if (hours !== undefined) candidate.sessionHours = sessionHours(hours);
    if (password !== undefined)
      candidate.password = verifier(checkPassword(password));
    this.data = candidate;
    if (password !== undefined)
      this.data.sessions = this.data.sessions.filter(
        (s) => s.tokenHash === digest(token),
      );
    this.save();
    return this.status(token);
  }
  revoke(token, { id, all = false } = {}) {
    this.require(token);
    const target =
      id || this.data.sessions.find((s) => s.tokenHash === digest(token)).id;
    this.data.sessions = all
      ? []
      : this.data.sessions.filter((s) => s.id !== target);
    this.save();
    return this.status(token);
  }
  prepareRecovery(token, password) {
    this.require(token);
    this.verify(password);
    const recoveryKey = newRecoveryKey(),
      confirmationId = crypto.randomUUID();
    this.pending = {
      confirmationId,
      verifier: verifier(normalizeRecoveryKey(recoveryKey)),
      expiresAt: this.now() + 10 * 60000,
    };
    return { recoveryKey, confirmationId, expiresAt: this.pending.expiresAt };
  }
  confirmRecovery(token, { confirmationId, recoveryKey }) {
    this.require(token);
    const pending = this.pending;
    if (
      !pending ||
      pending.expiresAt < this.now() ||
      pending.confirmationId !== confirmationId ||
      !matches(normalizeRecoveryKey(recoveryKey), pending.verifier)
    )
      throw Error("복구 키를 다시 생성하고 보관 확인을 완료하세요.");
    this.data.recovery = { ...pending.verifier, createdAt: this.now() };
    this.data.recoveryState = "active";
    this.save();
    this.pending = null;
    return this.status(token);
  }
  markRecoveryLost(token, password) {
    this.require(token);
    this.verify(password);
    this.data.recovery = null;
    this.data.recoveryState = "lost";
    this.pending = null;
    this.save();
    return this.status(token);
  }
  recover({ username: name, recoveryKey, password, name: deviceName }) {
    this.limiter.check();
    if (
      !this.data ||
      name !== this.data.username ||
      !matches(normalizeRecoveryKey(recoveryKey), this.data.recovery)
    )
      this.limiter.fail("사용자명과 복구 키를 확인하세요.");
    const passwordRecord = verifier(checkPassword(password));
    this.data.password = passwordRecord;
    this.data.sessions = [];
    this.data.recovery = null;
    this.data.recoveryState = "consumed";
    this.pending = null;
    this.limiter.clear();
    return this.issue(deviceName);
  }
}
