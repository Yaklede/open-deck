// Keep server state separate from fields edited in an open settings panel.
// Only explicit edits are sent back, so tablet changes to other fields survive.
export const deviceDefaults = Object.freeze({
  awake: true,
  orientation: "auto",
  theme: "system",
  language: "system",
  allowInsecureWifi: false,
  timeFormat: "24h",
  renderMode: "standard",
  fullscreen: true,
  brightness: -1,
  textScale: 100,
  haptics: true,
  fixedVibration: false,
  vibrationMs: 80,
  sound: false,
  swipeEnabled: true,
  reducedMotion: false,
  showHeader: true,
  showNavigation: true,
  settingsButtonHidden: false,
  screenSaverMinutes: 0,
  screenSaverMode: "dim",
  dimPercent: 10,
  firstTouchWakes: true,
  rememberPage: true,
  startPageId: "",
  profileId: "",
  iconResolution: 0,
  osNotifications: true,
  monitorNotifications: true,
  notificationBanner: true,
});
export class DeviceDrafts {
  constructor() {
    this.devices = new Map();
    this.edits = new Map();
    this.generations = new Map();
    this.submissions = new WeakMap();
    this.sequence = 0;
  }
  ingest(devices, { replace = false } = {}) {
    const ids = new Set(devices.map((d) => d.id));
    if (replace)
      for (const id of this.devices.keys())
        if (!ids.has(id)) {
          this.devices.delete(id);
          this.edits.delete(id);
          this.generations.delete(id);
        }
    for (const incoming of devices) {
      const old = this.devices.get(incoming.id);
      if (old && (incoming.settingsRevision || 0) < (old.settingsRevision || 0))
        continue;
      this.devices.set(incoming.id, { ...old, ...structuredClone(incoming) });
    }
  }
  view(id) {
    const device = this.devices.get(id);
    if (!device) return null;
    const edit = this.edits.get(id);
    return {
      ...device,
      ...(edit?.name !== undefined ? { name: edit.name } : {}),
      settings: { ...device.settings, ...edit?.settings },
    };
  }
  list() {
    return [...this.devices.keys()].map((id) => this.view(id));
  }
  set(id, key, value) {
    const device = this.devices.get(id);
    if (!device) return;
    const edit = this.edits.get(id) || { settings: {} };
    const target = key === "name" ? edit : edit.settings;
    const field = key === "name" ? "name" : key;
    const generations = this.generations.get(id) || new Map();
    generations.set(key, ++this.sequence);
    this.generations.set(id, generations);
    // Returning to the current server value is still a new edit: an older save
    // may be in flight and must not replace that explicit choice on arrival.
    target[field] = value;
    this.edits.set(id, edit);
  }
  patch(id) {
    const edit = this.edits.get(id);
    if (!edit) return null;
    const patch = { id, ...structuredClone(edit) };
    this.submissions.set(patch, new Map(this.generations.get(id)));
    return patch;
  }
  pending() {
    return [...this.edits.keys()].map((id) => this.patch(id));
  }
  get dirty() {
    return this.edits.size > 0;
  }
  discard() {
    this.edits.clear();
  }
  acknowledge(sent, device) {
    this.ingest([device]);
    const edit = this.edits.get(sent.id);
    if (!edit) return;
    // A user can keep typing while the request is in flight. Clear only values
    // actually acknowledged by this request, retaining subsequent edits.
    const submitted = this.submissions.get(sent),
      current = this.generations.get(sent.id);
    const unchanged = (key) =>
      submitted?.has(key) && submitted.get(key) === current?.get(key);
    if (sent.name !== undefined && edit.name === sent.name && unchanged("name"))
      delete edit.name;
    for (const [key, value] of Object.entries(sent.settings || {}))
      if (Object.is(edit.settings[key], value) && unchanged(key))
        delete edit.settings[key];
    if (edit.name === undefined && !Object.keys(edit.settings).length)
      this.edits.delete(sent.id);
  }
}
