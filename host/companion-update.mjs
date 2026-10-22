import { readZip } from "./safe-zip.mjs";

/** Read APK metadata without executing tooling or extracting archive paths. */
export function apkManifest(bytes) {
  const xml = readZip(bytes, {
    maxArchiveBytes: 100 * 1024 * 1024,
    maxBytes: 256 * 1024 * 1024,
    maxEntryBytes: 100 * 1024 * 1024,
    maxEntries: 20000,
  }).get("AndroidManifest.xml")?.bytes;
  if (!xml || xml.length > 4 * 1024 * 1024)
    throw Error("APK manifest is missing or too large.");
  let packageName,
    versionCode,
    versionCodeMajor = 0,
    versionName = "";
  if (xml.toString("utf8", 0, 100).trimStart().startsWith("<")) {
    const opening = xml.toString("utf8").match(/<manifest\b[^>]*>/)?.[0] || "";
    const attr = (name) =>
      opening.match(new RegExp(`(?:^|\\s)${name}=["']([^"']+)["']`))?.[1];
    packageName = attr("package");
    versionCode = Number(attr("android:versionCode"));
    versionCodeMajor = Number(attr("android:versionCodeMajor") || 0);
    versionName = attr("android:versionName") || "";
  } else {
    if (
      xml.length < 8 ||
      xml.readUInt16LE(0) !== 3 ||
      xml.readUInt32LE(4) !== xml.length
    )
      throw Error("Invalid binary APK manifest.");
    let strings = [];
    for (let offset = xml.readUInt16LE(2); offset < xml.length;) {
      if (offset + 8 > xml.length) throw Error("Truncated APK manifest.");
      const type = xml.readUInt16LE(offset),
        header = xml.readUInt16LE(offset + 2),
        size = xml.readUInt32LE(offset + 4);
      if (header < 8 || size < header || offset + size > xml.length)
        throw Error("Invalid APK manifest chunk.");
      if (type === 1) {
        if (header < 28) throw Error("Invalid APK string pool.");
        const count = xml.readUInt32LE(offset + 8),
          flags = xml.readUInt32LE(offset + 16),
          start = xml.readUInt32LE(offset + 20);
        if (count > 100000 || header + count * 4 > size || start >= size)
          throw Error("Invalid APK string pool bounds.");
        const limit = offset + size;
        strings = [];
        for (let i = 0; i < count; i++) {
          let p = offset + start + xml.readUInt32LE(offset + header + i * 4);
          if (p >= limit) throw Error("Invalid APK string offset.");
          const length8 = () => {
            if (p >= limit) throw Error("Truncated APK string.");
            let n = xml[p++];
            if (n & 128) {
              if (p >= limit) throw Error("Truncated APK string.");
              n = ((n & 127) << 8) | xml[p++];
            }
            return n;
          };
          if (flags & 0x100) {
            length8();
            const n = length8();
            if (p + n >= limit || xml[p + n] !== 0)
              throw Error("Invalid APK UTF-8 string.");
            strings.push(
              new TextDecoder("utf-8", { fatal: true }).decode(
                xml.subarray(p, p + n),
              ),
            );
          } else {
            if (p + 2 > limit) throw Error("Truncated APK string.");
            let n = xml.readUInt16LE(p);
            p += 2;
            if (n & 0x8000) {
              if (p + 2 > limit) throw Error("Truncated APK string.");
              n = (n & 0x7fff) * 65536 + xml.readUInt16LE(p);
              p += 2;
            }
            if (p + n * 2 + 2 > limit || xml.readUInt16LE(p + n * 2) !== 0)
              throw Error("Invalid APK UTF-16 string.");
            strings.push(xml.toString("utf16le", p, p + n * 2));
          }
        }
      } else if (type === 0x102) {
        if (header < 16 || header + 20 > size)
          throw Error("Invalid APK element.");
        const ext = offset + header,
          name = strings[xml.readUInt32LE(ext + 4)],
          start = xml.readUInt16LE(ext + 8),
          stride = xml.readUInt16LE(ext + 10),
          count = xml.readUInt16LE(ext + 12);
        if (start < 20 || stride < 20 || header + start + count * stride > size)
          throw Error("Invalid APK attributes.");
        if (name === "manifest")
          for (let i = 0; i < count; i++) {
            const p = ext + start + i * stride,
              key = strings[xml.readUInt32LE(p + 4)],
              raw = xml.readUInt32LE(p + 8),
              type = xml[p + 15],
              data = xml.readUInt32LE(p + 16),
              value =
                raw !== 0xffffffff
                  ? strings[raw]
                  : type === 3
                    ? strings[data]
                    : data;
            if (key === "package") packageName = value;
            else if (key === "versionCode") versionCode = Number(value);
            else if (key === "versionCodeMajor")
              versionCodeMajor = Number(value);
            else if (key === "versionName") versionName = String(value);
          }
      }
      offset += size;
    }
  }
  const longVersionCode = versionCodeMajor * 4294967296 + versionCode;
  if (
    packageName !== "app.opendeck.client" ||
    !Number.isSafeInteger(longVersionCode) ||
    longVersionCode < 1
  )
    throw Error("The APK package or version code is invalid.");
  return { packageName, versionCode: longVersionCode, versionName };
}

/** Opt-in periodic updater. Existing installations only; APK install -r enforces Android's signature continuity. */
export class CompanionUpdater {
  constructor({
    getSettings,
    listDevices,
    getPackage,
    installedPackage,
    installPackage,
    onEvent = () => {},
    now = Date.now,
  }) {
    Object.assign(this, {
      getSettings,
      listDevices,
      getPackage,
      installedPackage,
      installPackage,
      onEvent,
      now,
    });
    this.running = null;
    this.package = null;
    this.packageCheckedAt = 0;
    this.attempts = new Map();
    this.closed = false;
    this.nextCheckAt = 0;
  }
  status() {
    return {
      enabled: !!this.getSettings().usb.companionAutoUpdate,
      running: !!this.running,
      lastCheckedAt: this.packageCheckedAt || null,
      latestVersion: this.package?.versionName || null,
      latestVersionCode: this.package?.versionCode || null,
      devices: [...this.attempts].map(([serial, state]) => ({
        serial,
        ...state,
      })),
    };
  }
  tick() {
    if (
      this.closed ||
      !this.getSettings().usb.enabled ||
      !this.getSettings().usb.companionAutoUpdate
    )
      return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async run() {
    if (this.now() < this.nextCheckAt) return;
    let devices;
    try {
      devices = (await this.listDevices()).devices.filter(
        (d) => d.state === "device",
      );
      if (!devices.length) return;
      if (!this.package || this.now() - this.packageCheckedAt >= 30 * 60_000) {
        this.package = await this.getPackage();
        this.packageCheckedAt = this.now();
      }
    } catch (error) {
      this.nextCheckAt = this.now() + 5 * 60_000;
      this.onEvent("warn", "companion.update-check-failed", {
        reason: "release-check-failed",
      });
      return;
    }
    for (const device of devices) {
      if (this.closed || !this.getSettings().usb.companionAutoUpdate) break;
      const old = this.attempts.get(device.serial) || {};
      if (old.nextAttemptAt > this.now()) continue;
      try {
        const current = await this.installedPackage(device.serial);
        if (!current) {
          this.attempts.set(device.serial, {
            state: "not-installed",
            nextAttemptAt: this.now() + 5 * 60_000,
          });
          continue;
        }
        if (current.versionCode >= this.package.versionCode) {
          this.attempts.set(device.serial, {
            state: "up-to-date",
            installedVersionCode: current.versionCode,
            nextAttemptAt: this.now() + 5 * 60_000,
          });
          continue;
        }
        if (this.closed || !this.getSettings().usb.companionAutoUpdate) break;
        this.attempts.set(device.serial, {
          state: "installing",
          installedVersionCode: current.versionCode,
          nextAttemptAt: 0,
        });
        this.onEvent("info", "companion.update-started", {
          status: "installing",
          revision: this.package.versionCode,
        });
        await this.installPackage(device.serial, this.package);
        const after = await this.installedPackage(device.serial);
        if (!after || after.versionCode < this.package.versionCode)
          throw Error("The installed app version did not change.");
        this.attempts.set(device.serial, {
          state: "updated",
          installedVersionCode: after.versionCode,
          updatedAt: this.now(),
          nextAttemptAt: this.now() + 5 * 60_000,
        });
        this.onEvent("info", "companion.updated", {
          status: "updated",
          revision: this.package.versionCode,
        });
      } catch (error) {
        const failures = (old.failures || 0) + 1,
          nextAttemptAt =
            this.now() +
            Math.min(60 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 6));
        this.attempts.set(device.serial, {
          state: "failed",
          failures,
          nextAttemptAt,
          error: String(error.message).slice(0, 240),
        });
        this.onEvent("warn", "companion.update-failed", {
          reason:
            typeof error.code === "string" && /^[A-Z_]{1,60}$/.test(error.code)
              ? error.code
              : "device-update-failed",
          count: failures,
        });
      }
    }
    if (this.attempts.size > 100) {
      const connected = new Set(devices.map((d) => d.serial));
      for (const serial of this.attempts.keys())
        if (!connected.has(serial)) this.attempts.delete(serial);
    }
  }
  async close() {
    this.closed = true;
    await this.running;
  }
}
