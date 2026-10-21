import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { JiminOS } from "./extensions/jimin-os/index.mjs";
import { writeJson } from "./config.mjs";
export class Extensions {
  constructor({ dir, getConfig, onChange, providerOptions = {} }) {
    this.dir = dir;
    this.onChange = onChange;
    this.notifications = [];
    this.file = path.join(dir, "extension-notifications.json");
    try {
      this.notifications = JSON.parse(fs.readFileSync(this.file)).slice(-40);
    } catch {}
    this.mutationOwnersFile = path.join(dir, "extension-mutation-owners.json");
    try {
      this.mutationOwners = JSON.parse(
        fs.readFileSync(this.mutationOwnersFile),
      );
    } catch {
      this.mutationOwners = {};
    }
    this.providers = new Map([
      [
        "jimin-os",
        new JiminOS({
          dir,
          getOptions: () => getConfig().extensions?.["jimin-os"] || {},
          onChange,
          onNotification: (n) => this.notify(n),
          ...providerOptions,
        }),
      ],
    ]);
    this.timer = setInterval(() => this.poll(), 3000);
    this.timer.unref();
  }
  state() {
    return Object.fromEntries(
      [...this.providers].map(([id, p]) => [id, p.state()]),
    );
  }
  notify(n) {
    if (this.notifications.some((x) => x.id === n.id)) return;
    this.notifications = [
      ...this.notifications.filter((x) => x.createdAt > Date.now() - 86400000),
      n,
    ].slice(-40);
    writeJson(this.file, this.notifications);
    this.onChange();
  }
  testNotification() {
    this.notify({
      id: crypto.randomUUID(),
      provider: "jimin-os",
      title: "Jimin OS 연결을 확인했어요",
      body: "앞으로 일정과 업무 알림을 이 태블릿에서 확인할 수 있어요.",
      createdAt: Date.now(),
      entity: { kind: "home" },
    });
  }
  invoke(id, operation, parameters) {
    const p = this.providers.get(id);
    if (!p) throw Error("연결한 플러그인을 찾을 수 없어요.");
    return p.invoke(operation, parameters);
  }
  async mutate(owner, input) {
    const key = input.mutationId;
    if (typeof key !== "string" || !/^[0-9a-f-]{36}$/i.test(key))
      throw Error("잘못된 저장 요청이에요.");
    const existing = this.mutationOwners[key];
    if (existing && existing.owner !== owner)
      throw Error("이 기기의 저장 요청이 아니에요.");
    if (!existing) {
      const entries = Object.entries(this.mutationOwners)
        .filter(([, v]) => Date.now() - v.at < 86400000)
        .slice(-199);
      this.mutationOwners = Object.fromEntries(entries);
      this.mutationOwners[key] = { owner, at: Date.now() };
      writeJson(this.mutationOwnersFile, this.mutationOwners);
    }
    return this.providers.get("jimin-os").mutate(input);
  }
  mutationStatus(owner, id) {
    if (this.mutationOwners[id]?.owner !== owner)
      throw Error("이 기기의 저장 요청을 찾을 수 없어요.");
    return this.providers.get("jimin-os").mutationStatus(id);
  }
  poll() {
    for (const p of this.providers.values()) p.poll();
  }
  close() {
    clearInterval(this.timer);
    for (const p of this.providers.values()) p.close();
  }
}
export function osPage() {
  const buttons = [
    ["requests", "업무 요청", "tasks"],
    ["scheduled", "예약 업무", "clock"],
    ["new-schedule", "일정 추가", "calendar"],
    ["assistant", "지민에게 말하기", "spark"],
    ["tasks", "할 일", "tasks"],
    ["meetings", "회의 기록", "mic"],
  ];
  return {
    id: "jimin-os-page",
    name: "OS",
    columns: 8,
    rows: 6,
    theme: "midnight",
    gap: 12,
    radius: 16,
    widgets: [
      {
        id: "os-calendar",
        type: "calendar",
        label: "Jimin OS 일정",
        provider: "jimin-os",
        x: 0,
        y: 0,
        w: 4,
        h: 4,
        color: "#8fcfc1",
        style: {},
      },
      {
        id: "os-inbox",
        type: "inbox",
        label: "업무 요청",
        provider: "jimin-os",
        x: 4,
        y: 0,
        w: 4,
        h: 2,
        color: "#8fcfc1",
        style: {},
      },
      {
        id: "os-agenda",
        type: "agenda",
        label: "다가오는 일정",
        provider: "jimin-os",
        x: 4,
        y: 2,
        w: 4,
        h: 2,
        color: "#8fcfc1",
        style: {},
      },
      ...buttons.map(([view, label, icon], i) => ({
        id: "os-" + view,
        type: "button",
        label,
        icon,
        provider: "jimin-os",
        x: (i % 4) * 2,
        y: 4 + Math.floor(i / 4),
        w: 2,
        h: 1,
        color: "#8fcfc1",
        style: { textSize: 14 },
        actions: [
          {
            type: "extension",
            extensionId: "jimin-os",
            operation: "navigate",
            parameters: { view },
          },
        ],
      })),
      {
        id: "os-refresh",
        type: "button",
        label: "새로고침",
        icon: "refresh",
        x: 4,
        y: 5,
        w: 2,
        h: 1,
        color: "#8fcfc1",
        style: { textSize: 14 },
        actions: [
          { type: "extension", extensionId: "jimin-os", operation: "refresh" },
        ],
      },
      {
        id: "os-notifications",
        type: "notification-feed",
        label: "알림",
        provider: "jimin-os",
        x: 6,
        y: 5,
        w: 2,
        h: 1,
        color: "#8fcfc1",
        style: { textSize: 14 },
      },
    ],
  };
}
