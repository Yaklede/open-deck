import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Vorssaint } from "./extensions/vorssaint/index.mjs";
import { JiminOS } from "./extensions/jimin-os/index.mjs";
import { writeJson } from "./config.mjs";
export class Extensions {
  constructor({
    dir,
    getConfig,
    onChange,
    providerOptions = {},
    vorssaintOptions = {},
  }) {
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
      [
        "vorssaint",
        new Vorssaint({
          dir,
          getOptions: () => getConfig().extensions?.vorssaint || {},
          onChange,
          ...vorssaintOptions,
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
  const actions = [
    ["new-schedule", "일정 추가", "calendar", 0, 4, 4, true],
    ["tasks", "할 일", "tasks", 4, 4, 4, true],
    ["assistant", "지민에게 말하기", "spark", 8, 4, 4, true],
    ["requests", "업무 요청", "tasks", 0, 5, 3, false],
    ["scheduled", "예약 업무", "clock", 3, 5, 3, false],
    ["meetings", "회의 기록", "mic", 6, 5, 3, false],
    ["refresh", "새로고침", "refresh", 9, 5, 3, false],
  ];
  const style = { background: "#18222e", textSize: 16 };
  return {
    id: "jimin-os-page",
    name: "OS",
    columns: 12,
    rows: 6,
    theme: "graphite",
    background: "#101720",
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
        color: "#8ca5be",
        style: { ...style },
      },
      {
        id: "os-agenda",
        type: "agenda",
        label: "일정 · 할 일",
        provider: "jimin-os",
        x: 4,
        y: 0,
        w: 5,
        h: 4,
        color: "#8ca5be",
        style: { ...style, background: "#1c2835" },
      },
      {
        id: "os-inbox",
        type: "inbox",
        label: "업무 요청",
        provider: "jimin-os",
        x: 9,
        y: 0,
        w: 3,
        h: 2,
        color: "#8ca5be",
        style: { ...style },
      },
      {
        id: "os-notifications",
        type: "notification-feed",
        label: "최근 알림",
        provider: "jimin-os",
        x: 9,
        y: 2,
        w: 3,
        h: 2,
        color: "#8ca5be",
        style: { ...style },
      },
      ...actions.map(([view, label, icon, x, y, w, primary]) => ({
        id: "os-" + view,
        type: "button",
        label,
        icon,
        provider: "jimin-os",
        x,
        y,
        w,
        h: 1,
        color: "#8ca5be",
        style: {
          background:
            view === "new-schedule"
              ? "#273b50"
              : primary
                ? "#202d3b"
                : "#151f2a",
          textSize: primary ? 15 : 13,
          presentation: "os-action",
          emphasis: primary ? "primary" : "secondary",
        },
        actions: [
          {
            type: "extension",
            extensionId: "jimin-os",
            operation: view === "refresh" ? "refresh" : "navigate",
            ...(view === "refresh" ? {} : { parameters: { view } }),
          },
        ],
      })),
    ],
  };
}
