import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../host/scheduler.mjs";
test("daily schedule fires once per day, even after hundreds of scheduled events", async () => {
  const calls = [];
  const config = {
    automations: Array.from({ length: 32 }, (_, i) => ({
      id: String(i),
      widgetId: "button" + i,
      time: "09:00",
      enabled: true,
    })),
  };
  const s = new Scheduler(
    () => config,
    (id) => calls.push(id),
  );
  for (let day = 1; day <= 30; day++) {
    s.tick(new Date(2026, 9, day, 9, 0, 0));
    s.tick(new Date(2026, 9, day, 9, 0, 20));
    await Promise.resolve();
  }
  assert.equal(calls.length, 32 * 30);
});
test("disabled schedules and missed time slots do not execute", async () => {
  const calls = [];
  const s = new Scheduler(
    () => ({
      automations: [
        { id: "a", widgetId: "a", time: "09:00", enabled: false },
        { id: "b", widgetId: "b", time: "09:00", enabled: true },
      ],
    }),
    (id) => calls.push(id),
  );
  s.tick(new Date(2026, 9, 21, 8, 59));
  s.tick(new Date(2026, 9, 21, 9, 1));
  await Promise.resolve();
  assert.deepEqual(calls, []);
});
