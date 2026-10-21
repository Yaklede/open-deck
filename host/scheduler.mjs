export class Scheduler {
  constructor(getConfig, run) {
    this.getConfig = getConfig;
    this.run = run;
    this.day = "";
    this.executed = new Set();
  }
  tick(now = new Date()) {
    const day = [now.getFullYear(), now.getMonth(), now.getDate()].join("-");
    if (day !== this.day) {
      this.day = day;
      this.executed.clear();
    }
    const time = now.toTimeString().slice(0, 5);
    for (const a of this.getConfig().automations || []) {
      if (
        a.enabled &&
        a.time === time &&
        (!a.days || a.days.includes(now.getDay())) &&
        !this.executed.has(a.id)
      ) {
        this.executed.add(a.id);
        Promise.resolve()
          .then(() => this.run(a.widgetId))
          .catch(() => {});
      }
    }
  }
}
