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
export function sanitizeSnapshot(
  s,
  { allowStale = false, now = Date.now() } = {},
) {
  if (
    s?.schemaVersion !== 1 ||
    (s.connected !== true &&
      !(allowStale && s.connected === false && s.sync?.state === "retrying")) ||
    !Number.isFinite(s.updatedAt) ||
    s.updatedAt <= 0 ||
    s.updatedAt > now + 30000 ||
    (!allowStale && now - s.updatedAt > 120000)
  )
    throw Error("Jimin OS에서 서버 연결을 확인해 주세요.");
  return {
    schemaVersion: 1,
    capabilities: {
      scheduleCreate: s.capabilities?.scheduleCreate === true,
      taskComplete: s.capabilities?.taskComplete === true,
    },
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
        version: Number.isInteger(x.version) && x.version > 0 ? x.version : 0,
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
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.backendRetryAt = 0;
    this.lastAttemptAt = 0;
    this.bridgeConnected = false;
    this.reason = "waiting";
    this.lastDiagnostic = "";
    this.lastDiagnosticAt = 0;
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
      freshness: {
        state:
          this.status === "connected" &&
          this.data &&
          this.clock() - this.data.updatedAt < 45000
            ? "fresh"
            : this.data
              ? "stale"
              : "unavailable",
        collectedAt: this.data?.updatedAt || 0,
        lastAttemptAt: this.lastAttemptAt,
        retryAt: this.nextAttemptAt || this.backendRetryAt,
        failures: this.failures,
        bridgeConnected: this.bridgeConnected,
        reason: this.reason,
      },
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
      const failure = Error(
        "Jimin OS에서 연결 상태를 확인한 뒤 다시 눌러 주세요.",
      );
      failure.code = code;
      failure.httpStatus = res.status;
      throw failure;
    }
    const raw = await res.text();
    if (raw.length > 131072)
      throw Error("Jimin OS에서 전달한 정보가 너무 커요.");
    return JSON.parse(raw);
  }
  diagnostic(event, detail = {}) {
    detail = detail && typeof detail === "object" ? detail : {};
    const entry = {
      at: this.clock(),
      event,
      reason: this.reason,
      failures: this.failures,
      collectedAt: this.data?.updatedAt || 0,
      retryAt: this.nextAttemptAt || this.backendRetryAt,
      route: [
        "/v1/home",
        "/v1/schedule-entries",
        "/v1/scheduled-work",
      ].includes(detail.route)
        ? detail.route
        : "snapshot",
      code: ["http", "timeout", "network", "unavailable"].includes(detail.code)
        ? detail.code
        : "unavailable",
      httpStatus: Number.isInteger(detail.httpStatus)
        ? Math.max(0, Math.min(599, detail.httpStatus))
        : 0,
      durationMs: Number.isFinite(detail.durationMs)
        ? Math.max(0, Math.min(120000, detail.durationMs))
        : 0,
    };
    const signature = JSON.stringify([
      event,
      entry.reason,
      entry.route,
      entry.code,
      entry.httpStatus,
    ]);
    if (
      signature === this.lastDiagnostic &&
      this.clock() - this.lastDiagnosticAt < 60000
    )
      return;
    this.lastDiagnostic = signature;
    this.lastDiagnosticAt = this.clock();
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, "jimin-os-sync.jsonl");
      if (fs.existsSync(file) && fs.statSync(file).size > 262144)
        fs.renameSync(file, file + ".previous");
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch {
      /* Diagnostics must never interrupt reconnection. */
    }
  }
  async poll() {
    if (this.closed || this.busy) return;
    if (!this.getOptions().enabled) {
      if (this.data || this.status !== "disabled") {
        this.data = null;
        this.status = "disabled";
        this.error = "";
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.onChange();
      }
      return;
    }
    if (this.clock() < this.nextAttemptAt) return;
    this.busy = true;
    this.lastAttemptAt = this.clock();
    try {
      const raw = await this.request("snapshot");
      this.bridgeConnected = true;
      this.backendRetryAt = Number.isFinite(raw.sync?.retryAt)
        ? raw.sync.retryAt
        : 0;
      const next = sanitizeSnapshot(raw, {
        allowStale: true,
        now: this.clock(),
      });
      const fresh =
        raw.connected === true &&
        raw.sync?.state !== "retrying" &&
        this.clock() - next.updatedAt < 45000;
      if (!this.data || next.updatedAt >= this.data.updatedAt) this.data = next;
      if (!fresh) {
        this.status = "stale";
        this.reason = raw.connected ? "collection_delayed" : "backend_retrying";
        this.error =
          "이전 데이터를 보여주고 있어요. 자동으로 다시 연결하고 있어요.";
        this.failures = Math.max(
          this.failures,
          Number(raw.sync?.failures) || 1,
        );
        this.nextAttemptAt = 0; // Keep reading the live bridge while Jimin OS retries its server.
        this.diagnostic("refresh_failed", raw.sync?.error);
      } else {
        if (this.status !== "connected") {
          this.reason = "fresh";
          this.diagnostic("recovered");
        }
        this.status = "connected";
        this.reason = "fresh";
        this.error = "";
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.backendRetryAt = 0;
        this.reminders(next);
      }
    } catch (cause) {
      this.bridgeConnected = false;
      this.failures++;
      this.status = this.data ? "stale" : "disconnected";
      this.reason = "bridge_unavailable";
      this.error = this.data
        ? "이전 데이터를 보여주고 있어요. 자동으로 다시 연결하고 있어요."
        : "Jimin OS에 다시 연결하고 있어요. 맥에서 앱과 로그인을 확인해 주세요.";
      this.nextAttemptAt =
        this.clock() +
        Math.min(15000, 3000 * 2 ** Math.min(this.failures - 1, 3));
      this.diagnostic("refresh_failed", {
        code: ["TimeoutError", "AbortError"].includes(cause?.name)
          ? "timeout"
          : "unavailable",
        httpStatus: cause?.httpStatus,
        durationMs: this.clock() - this.lastAttemptAt,
      });
      // Keep the last successful collection and its original timestamp.
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
  async mutate(input) {
    const create = input.operation === "create-schedule",
      complete = input.operation === "complete-task";
    if (
      !this.getOptions().enabled ||
      this.status !== "connected" ||
      !this.data ||
      this.clock() - this.data.updatedAt >= 45000
    )
      throw Error("Jimin OS 연결을 확인한 뒤 다시 시도해 주세요.");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.mutationId,
      ) ||
      (!create && !complete)
    )
      throw Error("잘못된 저장 요청이에요.");
    const command = {
      mutationId: input.mutationId,
      operation: input.operation,
      retry: input.retry === true,
    };
    if (create) {
      if (
        !this.data.capabilities?.scheduleCreate ||
        typeof input.title !== "string" ||
        !input.title.trim() ||
        input.title.length > 160 ||
        (typeof input.notes !== "string" && input.notes !== undefined) ||
        String(input.notes || "").length > 2000 ||
        !date(input.startsAt) ||
        !date(input.endsAt) ||
        Date.parse(input.endsAt) <= Date.parse(input.startsAt) ||
        Date.parse(input.endsAt) - Date.parse(input.startsAt) > 366 * 86400000
      )
        throw Error("일정 제목과 시작·종료 시간을 확인해 주세요.");
      Object.assign(command, {
        title: input.title.trim(),
        notes: input.notes || "",
        startsAt: new Date(input.startsAt).toISOString(),
        endsAt: new Date(input.endsAt).toISOString(),
      });
    } else {
      if (
        !this.data.capabilities?.taskComplete ||
        !id(input.itemId) ||
        !Number.isInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        (typeof input.completionNote !== "string" &&
          input.completionNote !== undefined) ||
        String(input.completionNote || "").length > 2000
      )
        throw Error("할 일 정보를 다시 확인해 주세요.");
      // Ownership is also checked by Jimin OS against its published tasks and server session.
      Object.assign(command, {
        itemId: input.itemId,
        expectedVersion: input.expectedVersion,
        completionNote: input.completionNote || "",
      });
    }
    try {
      return await this.request("mutations", command);
    } catch (error) {
      if (
        ["CONFLICT", "INVALID", "ID_REUSED", "UNAUTHORIZED"].includes(
          error.code,
        )
      )
        return {
          mutationId: command.mutationId,
          status: "failed",
          error:
            error.code === "UNAUTHORIZED"
              ? "AUTH_REQUIRED"
              : error.code === "ID_REUSED"
                ? "CONFLICT"
                : error.code,
        };
      throw error;
    }
  }
  async mutationStatus(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error("잘못된 저장 요청이에요.");
    try {
      return await this.request("mutations/" + id);
    } catch (error) {
      if (error.code === "NOT_FOUND")
        return { mutationId: id, status: "not-found" };
      throw error;
    }
  }
  close() {
    this.closed = true;
  }
}
