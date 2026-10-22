import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function setSecret(id, value) {
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
    typeof value !== "string" ||
    value.length > 4096
  )
    throw Error("인증 값을 확인하세요.");
  if (process.platform !== "darwin")
    throw Error("인증 값은 macOS 키체인에서 설정하세요.");
  if (!value) {
    await exec("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      "app.opendeck.connector",
      "-a",
      id,
    ]).catch(() => {});
    return;
  }
  await exec(
    "/usr/bin/security",
    [
      "add-generic-password",
      "-U",
      "-s",
      "app.opendeck.connector",
      "-a",
      id,
      "-w",
      value,
    ],
    { timeout: 5000 },
  );
}
export async function readSecret(id) {
  if (process.platform !== "darwin") return "";
  try {
    return (
      await exec(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          "app.opendeck.connector",
          "-a",
          id,
          "-w",
        ],
        { timeout: 3000 },
      )
    ).stdout.trim();
  } catch {
    return "";
  }
}
export async function httpRequest(
  i,
  fetcher = fetch,
  userAgent = "OpenDeck",
  secretReader = readSecret,
) {
  const headers = {
    Accept: "application/json",
    "User-Agent": userAgent || "OpenDeck",
  };
  if (i.auth) {
    const token = await secretReader(i.id);
    if (!token) throw Error("맥에서 연동 인증 토큰을 등록하세요.");
    headers.Authorization = "Bearer " + token;
  }
  if (i.body) headers["Content-Type"] = "application/json";
  const res = await fetcher(i.url, {
    method: i.method || "GET",
    headers,
    body: i.body || undefined,
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!res.ok) throw Error("HTTP " + res.status);
  const reader = res.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 524288) throw Error("응답이 너무 큽니다.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = text.slice(0, 2048);
  }
  for (const part of String(i.path || "")
    .split(".")
    .filter(Boolean))
    result = result?.[part];
  if (!["number", "string", "boolean"].includes(typeof result))
    throw Error("단일 값이 되는 JSON 경로를 지정하세요.");
  return typeof result === "string" ? result.slice(0, 2048) : result;
}
export class Connectors {
  constructor(getConfig, setVariable, onChange) {
    this.getConfig = getConfig;
    this.setVariable = setVariable;
    this.onChange = onChange;
    this.status = {};
    this.next = new Map();
    this.running = new Set();
    this.closed = false;
    this.controllers = [];
  }
  async run(id) {
    const i = this.getConfig().integrations.find((i) => i.id === id);
    if (!i) throw Error("연동을 찾을 수 없습니다.");
    if (this.running.has(id)) throw Error("이미 갱신 중입니다.");
    this.running.add(id);
    this.status[id] = { state: "loading", at: Date.now() };
    this.onChange();
    try {
      const value = await httpRequest(
        i,
        fetch,
        this.getSettings?.().http.userAgent,
        this.secret,
      );
      if (this.closed) return;
      const current = this.getConfig().integrations.find((x) => x.id === id);
      if (!current) return;
      if (current.variable) this.setVariable(current.variable, value);
      this.status[id] = { state: "ok", at: Date.now(), value };
      return value;
    } catch (e) {
      this.status[id] = { state: "error", at: Date.now(), message: e.message };
      throw e;
    } finally {
      this.running.delete(id);
      if (!this.closed) this.onChange();
    }
  }
  tick() {
    for (const i of this.getConfig().integrations) {
      if (
        !i.enabled ||
        (i.method && i.method !== "GET") ||
        !i.variable ||
        this.running.has(i.id)
      )
        continue;
      if (Date.now() >= (this.next.get(i.id) || 0)) {
        this.next.set(i.id, Date.now() + (i.intervalSeconds || 60) * 1000);
        this.run(i.id).catch(() => {});
      }
    }
  }
  close() {
    this.closed = true;
  }
}
