import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { writeJson } from "../../config.mjs";
export const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url)),
);
const id = (v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const text = (v, n = 160) => (typeof v === "string" ? v.slice(0, n) : "");
const rows = (v) =>
  Array.isArray(v)
    ? v.filter((x) => x && typeof x === "object" && !Array.isArray(x))
    : [];
const date = (v) =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : "";
export function sanitizeSnapshot(s) {
  if (
    s?.schemaVersion !== 1 ||
    s.connected !== true ||
    !Number.isFinite(s.updatedAt) ||
    Math.abs(Date.now() - s.updatedAt) > 120000
  )
    throw Error("Jimin OS에서 서버 연결을 확인해 주세요.");
  return {
    schemaVersion: 1,
    updatedAt: s.updatedAt,
    timeZone: "Asia/Seoul",
    range: { from: date(s.range?.from), to: date(s.range?.to) },
    counts: Object.fromEntries(
      ["requests", "updates", "uncertain", "today", "overdue"].map((k) => [
        k,
        Math.max(0, Math.min(9999, Number(s.counts?.[k]) || 0)),
      ]),
    ),
    events: rows(s.events)
      .filter((x) => id(x.id) && date(x.startsAt) && date(x.endsAt))
      .slice(0, 120)
      .map((x) => ({
        id: x.id,
        title: text(x.title),
        startsAt: x.startsAt,
        endsAt: x.endsAt,
        source: text(x.source, 30),
      })),
    tasks: rows(s.tasks)
      .filter((x) => id(x.id))
      .slice(0, 40)
      .map((x) => ({
        id: x.id,
        title: text(x.title),
        dueAt: date(x.dueAt) || null,
        assignee: text(x.assignee, 60),
        state: text(x.state, 30),
      })),
    inbox: rows(s.inbox)
      .filter((x) => id(x.id))
      .slice(0, 30)
      .map((x) => ({
        id: x.id,
        title: text(x.title),
        projectName: text(x.projectName, 60),
        receivedAt: date(x.receivedAt),
        kind: ["request", "update", "uncertain"].includes(x.kind)
          ? x.kind
          : "request",
        revision: Number(x.revision) || 0,
      })),
    routines: rows(s.routines)
      .filter((x) => id(x.id))
      .slice(0, 20)
      .map((x) => ({
        id: x.id,
        title: text(x.title),
        nextRunAt: date(x.nextRunAt),
        enabled: x.enabled === true,
      })),
  };
}
export class JiminOS {
  constructor({
    dir,
    getOptions = () => ({}),
    onChange = () => {},
    onNotification = () => {},
    bridgePath = path.join(
      os.homedir(),
      "Library/Application Support/io.jimin.os/open-deck-bridge.json",
    ),
    fetcher = fetch,
    clock = () => Date.now(),
  }) {
    Object.assign(this, {
      dir,
      getOptions,
      onChange,
      onNotification,
      bridgePath,
      fetcher,
      clock,
    });
    this.status = "disconnected";
    this.data = null;
    this.error = "";
    this.busy = false;
    this.closed = false;
    this.seen = new Set();
    this.baselined = false;
    this.activeActions = new Set();
    this.bookFile = path.join(dir, "jimin-os-seen.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.bookFile));
      this.seen = new Set(saved.seen || []);
      this.baselined = saved.baselined === true;
    } catch {}
  }
  state() {
    return {
      ...manifest,
      status: this.status,
      error: this.error,
      data: this.data,
      enabled: this.getOptions().enabled === true,
    };
  }
  descriptor() {
    const stat = fs.lstatSync(this.bridgePath);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error("Jimin OS 연결 정보를 확인해 주세요.");
    const d = JSON.parse(fs.readFileSync(this.bridgePath));
    if (
      d.protocol !== 1 ||
      !Number.isInteger(d.port) ||
      d.port < 1024 ||
      d.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(d.token)
    )
      throw Error("Jimin OS를 최신 버전으로 열어 주세요.");
    return d;
  }
  async request(route, body) {
    const d = this.descriptor(),
      res = await this.fetcher(`http://127.0.0.1:${d.port}/v1/${route}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + d.token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(body ? 10000 : 2200),
        redirect: "error",
      });
    if (!res.ok) {
      let code = "";
      try {
        code = (await res.json()).error;
      } catch {}
      if (code === "ACTION_TIMEOUT")
        throw Error(
          "응답이 늦어 실행을 취소했어요. 연결을 확인한 뒤 다시 눌러 주세요.",
        );
      if (code === "BUSY")
        throw Error("진행 중인 동작이 있어요. 잠시 후 다시 눌러 주세요.");
      if (code === "BUSY_EDITING")
        throw Error("Jimin OS에서 편집 중인 내용을 먼저 저장해 주세요.");
      throw Error("Jimin OS에서 연결 상태를 확인한 뒤 다시 눌러 주세요.");
    }
    const raw = await res.text();
    if (raw.length > 131072)
      throw Error("Jimin OS에서 전달한 정보가 너무 커요.");
    return JSON.parse(raw);
  }
  async poll() {
    if (this.closed || this.busy) return;
    if (!this.getOptions().enabled) {
      if (this.data || this.status !== "disabled") {
        this.data = null;
        this.status = "disabled";
        this.error = "";
        this.onChange();
      }
      return;
    }
    this.busy = true;
    try {
      const next = sanitizeSnapshot(await this.request("snapshot"));
      this.data = next;
      this.status = "connected";
      this.error = "";
      this.reminders(next);
    } catch {
      this.status = "disconnected";
      this.error = "Jimin OS 앱을 열어 연결 상태를 확인해 주세요.";
      this.data = null;
    } finally {
      this.busy = false;
      if (!this.closed) this.onChange();
    }
  }
  persist() {
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-700));
    writeJson(this.bookFile, {
      baselined: this.baselined,
      seen: [...this.seen],
    });
  }
  reminders(data) {
    const enabled = this.getOptions().notifications !== false,
      now = this.clock(),
      lead = (this.getOptions().reminderMinutes || 10) * 60000;
    let changed = false;
    const emit = (key, title, body, entity) => {
      if (this.seen.has(key)) return;
      this.seen.add(key);
      changed = true;
      if (enabled)
        this.onNotification({
          id: crypto
            .createHash("sha256")
            .update(key)
            .digest("hex")
            .slice(0, 24),
          provider: "jimin-os",
          title,
          body,
          createdAt: now,
          entity,
        });
    };
    for (const x of data.inbox) {
      const key = `inbox:${x.id}:${x.revision}`;
      if (!this.baselined) {
        this.seen.add(key);
        changed = true;
      } else
        emit(
          key,
          x.kind === "update"
            ? "기존 일감에 새 소식이 있어요"
            : "새 업무 요청이 도착했어요",
          `${x.projectName} · ${x.title}`,
          { kind: "inbox", id: x.id },
        );
    }
    for (const x of data.events) {
      const at = Date.parse(x.startsAt);
      if (at > now - 120000 && at <= now + lead)
        emit(`schedule:${x.id}:${x.startsAt}`, "곧 일정이 시작돼요", x.title, {
          kind: "schedule",
          id: x.id,
        });
    }
    for (const x of data.tasks) {
      const at = Date.parse(x.dueAt);
      if (at > now - 120000 && at <= now + lead)
        emit(`task:${x.id}:${x.dueAt}`, "할 일의 마감이 다가와요", x.title, {
          kind: "task",
          id: x.id,
        });
    }
    if (!this.baselined) {
      this.baselined = true;
      changed = true;
    }
    if (changed) this.persist();
  }
  async invoke(operation, parameters = {}) {
    if (!this.getOptions().enabled)
      throw Error("맥 편집기에서 Jimin OS를 연결해 주세요.");
    const views = [
      "home",
      "calendar",
      "tasks",
      "requests",
      "scheduled",
      "meetings",
      "memory",
      "assistant",
      "notifications",
      "new-schedule",
      "new-task",
    ];
    let action;
    if (operation === "navigate" && views.includes(parameters.view))
      action = { operation, view: parameters.view };
    else if (operation === "refresh") action = { operation };
    else if (
      operation === "open-schedule" &&
      this.data?.events.some((x) => x.id === parameters.itemId)
    )
      action = { operation, itemId: parameters.itemId };
    else if (
      operation === "open-task" &&
      this.data?.tasks.some((x) => x.id === parameters.itemId)
    )
      action = { operation, itemId: parameters.itemId };
    else throw Error("이 기능은 현재 연결에서 사용할 수 없어요.");
    const key = JSON.stringify(action);
    if (this.activeActions.has(key)) return { ignored: true };
    if (this.activeActions.size >= 3)
      throw Error("다른 동작이 진행 중이에요. 잠시 후 다시 눌러 주세요.");
    this.activeActions.add(key);
    try {
      const result = await this.request("action", action);
      if (operation === "refresh") await this.poll();
      return result;
    } finally {
      this.activeActions.delete(key);
    }
  }
  close() {
    this.closed = true;
  }
}
