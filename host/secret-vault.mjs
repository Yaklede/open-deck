import path from "node:path";
import crypto from "node:crypto";
import {
  readPrivateJson,
  writePrivateJson,
  checkPassword,
  hashSecret,
  verifier,
  matches,
  newRecoveryKey,
  normalizeRecoveryKey,
  AttemptLimiter,
} from "./security-storage.mjs";

export const VAULT_BACKUP_KIND = "open-deck-backup-vault-encrypted";
const vaultError = () =>
  Object.assign(
    Error("비밀 저장소가 잠겨 있습니다. 암호 또는 복구 키로 해제하세요."),
    { status: 423, code: "VAULT_LOCKED" },
  );
function bytes(value, length) {
  if (
    typeof value !== "string" ||
    value.length > 100 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw Error("암호화 파일 형식을 확인하세요.");
  const result = Buffer.from(value, "base64");
  if (
    result.toString("base64") !== value ||
    (length && result.length !== length)
  )
    throw Error("암호화 파일 형식을 확인하세요.");
  return result;
}
function seal(value, key, context) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}
function open(value, key, context) {
  if (value?.algorithm !== "aes-256-gcm")
    throw Error("지원하지 않는 암호화 형식입니다.");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    bytes(value.iv, 12),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes(value.tag, 16));
  return Buffer.concat([decipher.update(bytes(value.data)), decipher.final()]);
}
function wrap(master, password, context) {
  const salt = crypto.randomBytes(16).toString("hex"),
    key = hashSecret(password, salt);
  try {
    return { salt, kdf: "scrypt", ...seal(master, key, context) };
  } finally {
    key.fill(0);
  }
}
function unwrap(wrapped, password, context) {
  if (
    !wrapped ||
    wrapped.kdf !== "scrypt" ||
    !/^[a-f0-9]{32}$/.test(wrapped.salt) ||
    typeof password !== "string" ||
    password.length > 256
  )
    throw Error("암호화 키 정보를 확인하세요.");
  const key = hashSecret(password, wrapped.salt);
  try {
    const master = open(wrapped, key, context);
    if (master.length !== 32) throw Error("암호화 키 정보를 확인하세요.");
    return master;
  } finally {
    key.fill(0);
  }
}
function secretId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))
    throw Error("비밀 식별자는 영문·숫자·밑줄·하이픈 1~80자여야 합니다.");
  return id;
}

export class SecretVault {
  constructor({ dir, now = Date.now }) {
    this.file = path.join(dir, "vault-keyring.json");
    this.secretFile = path.join(dir, "vault-secrets.json");
    this.now = now;
    this.data = readPrivateJson(this.file);
    this.key = null;
    this.pending = null;
    this.limiter = new AttemptLimiter(now);
    if (
      this.data &&
      (this.data.version !== 1 ||
        !/^[a-f0-9-]{36}$/.test(this.data.id) ||
        !this.data.password)
    )
      throw Error("비밀 저장소 키 파일을 확인하세요.");
  }
  save() {
    writePrivateJson(this.file, this.data);
  }
  required() {
    if (!this.key || !this.data) throw vaultError();
    return this.key;
  }
  status() {
    return {
      configured: !!this.data,
      unlocked: !!this.key,
      localBackupsEncrypted: !!this.data?.localBackupsEncrypted,
      recoveryConfigured: !!this.data?.recovery,
      recoveryCreatedAt: this.data?.recovery?.createdAt || null,
      recoveryPending: !!this.pending,
      recoveryState: this.pending
        ? "pending"
        : this.data?.recovery
          ? "active"
          : this.data?.recoveryState || "missing",
      secretCount: this.data?.secretCount || 0,
    };
  }
  setup(password) {
    if (this.data) throw Error("비밀 저장소가 이미 있습니다.");
    checkPassword(password);
    const id = crypto.randomUUID(),
      master = crypto.randomBytes(32);
    const data = {
      version: 1,
      id,
      createdAt: this.now(),
      password: wrap(master, password, `Open Deck vault password ${id}`),
      recovery: null,
      localBackupsEncrypted: false,
      secretCount: 0,
      secretIds: [],
    };
    writePrivateJson(this.file, data);
    this.data = data;
    this.key = master;
    return this.status();
  }
  unlock(password) {
    this.limiter.check();
    if (!this.data) throw Error("먼저 비밀 저장소를 설정하세요.");
    let key;
    try {
      key = unwrap(
        this.data.password,
        password,
        `Open Deck vault password ${this.data.id}`,
      );
    } catch {
      this.limiter.fail("저장소 암호를 확인하세요.");
    }
    this.lock();
    this.key = key;
    this.limiter.clear();
    return this.status();
  }
  lock() {
    this.key?.fill(0);
    this.key = null;
    this.pending = null;
    return this.status();
  }
  changePassword(currentPassword, password) {
    checkPassword(password);
    this.unlock(currentPassword);
    this.data.password = wrap(
      this.required(),
      password,
      `Open Deck vault password ${this.data.id}`,
    );
    this.save();
    return this.status();
  }
  prepareRecovery() {
    const master = this.required(),
      recoveryKey = newRecoveryKey(),
      normalized = normalizeRecoveryKey(recoveryKey),
      confirmationId = crypto.randomUUID();
    this.pending = {
      confirmationId,
      expiresAt: this.now() + 10 * 60000,
      verifier: verifier(normalized),
      wrapped: wrap(
        master,
        normalized,
        `Open Deck vault recovery ${this.data.id}`,
      ),
    };
    return { recoveryKey, confirmationId, expiresAt: this.pending.expiresAt };
  }
  confirmRecovery({ confirmationId, recoveryKey }) {
    this.required();
    const p = this.pending;
    if (
      !p ||
      p.expiresAt < this.now() ||
      p.confirmationId !== confirmationId ||
      !matches(normalizeRecoveryKey(recoveryKey), p.verifier)
    )
      throw Error("복구 키를 다시 생성하고 보관 확인을 완료하세요.");
    this.data.recovery = {
      ...p.verifier,
      wrapped: p.wrapped,
      createdAt: this.now(),
    };
    this.data.recoveryState = "active";
    this.save();
    this.pending = null;
    return this.status();
  }
  markRecoveryLost() {
    this.required();
    this.data.recovery = null;
    this.data.recoveryState = "lost";
    this.pending = null;
    this.save();
    return this.status();
  }
  recover({ recoveryKey, password }) {
    checkPassword(password);
    this.limiter.check();
    const normalized = normalizeRecoveryKey(recoveryKey);
    if (!this.data?.recovery || !matches(normalized, this.data.recovery))
      this.limiter.fail("저장소 복구 키를 확인하세요.");
    let key;
    try {
      key = unwrap(
        this.data.recovery.wrapped,
        normalized,
        `Open Deck vault recovery ${this.data.id}`,
      );
    } catch {
      this.limiter.fail("저장소 복구 키를 확인하세요.");
    }
    const wrapped = wrap(
      key,
      password,
      `Open Deck vault password ${this.data.id}`,
    );
    this.lock();
    this.key = key;
    this.data.password = wrapped;
    this.data.recovery = null;
    this.data.recoveryState = "consumed";
    this.save();
    this.limiter.clear();
    return this.status();
  }
  setBackupEncryption(enabled) {
    this.required();
    if (typeof enabled !== "boolean") throw Error("암호화 설정을 확인하세요.");
    if (enabled && !this.data.recovery)
      throw Error("먼저 저장소 복구 키를 생성하고 보관 확인을 완료하세요.");
    this.data.localBackupsEncrypted = enabled;
    this.save();
    return this.status();
  }
  secrets() {
    const key = this.required(),
      value = readPrivateJson(this.secretFile);
    if (!value) return {};
    try {
      return JSON.parse(
        open(value, key, `Open Deck vault secrets ${this.data.id}`).toString(
          "utf8",
        ),
      );
    } catch {
      throw Error("비밀 저장소 데이터가 손상되었습니다.");
    }
  }
  listSecrets() {
    return Object.entries(this.secrets()).map(([id, { value, ...entry }]) => ({
      id,
      ...entry,
    }));
  }
  setSecret({ id, label = "", value }) {
    secretId(id);
    if (
      typeof label !== "string" ||
      label.length > 100 ||
      typeof value !== "string" ||
      !value ||
      value.length > 4096
    )
      throw Error("비밀 이름과 값(1~4096자)을 확인하세요.");
    const secrets = this.secrets();
    if (!Object.hasOwn(secrets, id) && Object.keys(secrets).length >= 200)
      throw Error("비밀은 최대 200개까지 보관할 수 있습니다.");
    secrets[id] = { label, value, updatedAt: this.now() };
    this.saveSecrets(secrets);
    return this.listSecrets();
  }
  saveSecrets(secrets) {
    writePrivateJson(
      this.secretFile,
      seal(
        Buffer.from(JSON.stringify(secrets)),
        this.required(),
        `Open Deck vault secrets ${this.data.id}`,
      ),
    );
    this.data.secretIds = Object.keys(secrets);
    this.data.secretCount = this.data.secretIds.length;
    this.save();
  }
  hasSecret(id) {
    secretId(id);
    if (!this.data) return false;
    if (Array.isArray(this.data.secretIds))
      return this.data.secretIds.includes(id);
    return this.key
      ? Object.hasOwn(this.secrets(), id)
      : this.data.secretCount > 0;
  }
  removeSecret(id) {
    secretId(id);
    const secrets = this.secrets();
    delete secrets[id];
    this.saveSecrets(secrets);
    return this.listSecrets();
  }
  readSecret(id) {
    secretId(id);
    return this.secrets()[id]?.value || "";
  }
  encryptBackup(archive, { recoveryProtected = false } = {}) {
    const envelope = {
      kind: VAULT_BACKUP_KIND,
      formatVersion: 1,
      keyId: this.data?.id,
      createdAt: archive.createdAt,
      reason: archive.reason,
      ...seal(
        Buffer.from(JSON.stringify(archive)),
        this.required(),
        `Open Deck local backup ${this.data.id}`,
      ),
    };
    if (recoveryProtected) {
      if (!this.data.recovery) throw Error("먼저 저장소 복구 키를 보관하세요.");
      envelope.recovery = structuredClone(this.data.recovery.wrapped);
    }
    return envelope;
  }
  decryptBackup(envelope, recoveryKey) {
    if (
      envelope.kind !== VAULT_BACKUP_KIND ||
      envelope.formatVersion !== 1 ||
      !/^[a-f0-9-]{36}$/.test(envelope.keyId)
    )
      throw Error("암호화 백업 형식을 확인하세요.");
    let key,
      temporary = false;
    if (envelope.keyId === this.data?.id && this.key) key = this.key;
    else if (recoveryKey && envelope.recovery) {
      this.limiter.check();
      try {
        key = unwrap(
          envelope.recovery,
          normalizeRecoveryKey(recoveryKey),
          `Open Deck vault recovery ${envelope.keyId}`,
        );
        temporary = true;
      } catch {
        this.limiter.fail("백업 복구 키를 확인하세요.");
      }
    } else throw vaultError();
    try {
      const result = JSON.parse(
        open(
          envelope,
          key,
          `Open Deck local backup ${envelope.keyId}`,
        ).toString("utf8"),
      );
      if (temporary) this.limiter.clear();
      return result;
    } catch {
      throw Error("암호화 백업이 손상되었거나 복구 키가 다릅니다.");
    } finally {
      if (temporary) key.fill(0);
    }
  }
}
