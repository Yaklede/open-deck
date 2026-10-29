import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { CompanionUpdater, apkManifest } from "../host/companion-update.mjs";
import {
  downloadCompanionPackage,
  installedCompanion,
  installCompanionPackage,
} from "../host/system-tools.mjs";
import { writeZip } from "../host/safe-zip.mjs";
const apk = (packageName = "app.opendeck.client", version = 20) =>
  writeZip({
    "AndroidManifest.xml": Buffer.from(
      `<manifest package="${packageName}" android:versionCode="${version}" android:versionName="0.10.0"></manifest>`,
    ),
  });
function fixture(extra = {}) {
  let now = 1000000,
    version = 10,
    enabled = true,
    installCount = 0,
    packageCount = 0;
  const events = [];
  const updater = new CompanionUpdater({
    now: () => now,
    getSettings: () => ({
      usb: { enabled: true, companionAutoUpdate: enabled },
    }),
    listDevices: async () => ({
      devices: [{ serial: "synthetic-device", state: "device" }],
    }),
    getPackage: async () => {
      packageCount++;
      return { versionCode: 20, versionName: "0.10.0" };
    },
    installedPackage: async () => ({ versionCode: version }),
    installPackage: async () => {
      installCount++;
      version = 20;
    },
    onEvent: (...v) => events.push(v),
    ...extra,
  });
  return {
    updater,
    events,
    setTime: (n) => (now = n),
    advance: (n) => (now += n),
    enable: (v) => (enabled = v),
    version: (v) => (version = v),
    installs: () => installCount,
    packages: () => packageCount,
  };
}
test("APK binary manifest reads the actual Open Deck Android package and version code", () => {
  const manifest = fs.readFileSync(
    new URL("./fixtures/android/AndroidManifest.axml", import.meta.url),
  );
  assert.deepEqual(apkManifest(writeZip({ "AndroidManifest.xml": manifest })), {
    packageName: "app.opendeck.client",
    versionCode: 15,
    versionName: "0.9.0",
  });
  assert.throws(() => apkManifest(apk("other.app")), /package/);
  assert.throws(() => apkManifest(apk("app.opendeck.client", 0)), /version/);
  assert.throws(
    () => apkManifest(writeZip({ "AndroidManifest.xml": Buffer.alloc(20) })),
    /binary/,
  );
});
test("opt-in gates updater and concurrent checks/install are deduplicated", async () => {
  const f = fixture();
  f.enable(false);
  await f.updater.tick();
  assert.equal(f.packages(), 0);
  f.enable(true);
  await Promise.all([f.updater.tick(), f.updater.tick(), f.updater.tick()]);
  assert.equal(f.packages(), 1);
  assert.equal(f.installs(), 1);
  assert.equal(f.updater.status().devices[0].state, "updated");
  await f.updater.tick();
  assert.equal(f.installs(), 1);
  f.advance(300001);
  await f.updater.tick();
  assert.equal(f.updater.status().devices[0].state, "up-to-date");
  await f.updater.close();
  f.advance(2000000);
  await f.updater.tick();
  assert.equal(f.installs(), 1);
});
test("equal/newer app versions and uninstalled devices are never replaced automatically", async () => {
  const same = fixture();
  same.version(20);
  await same.updater.tick();
  assert.equal(same.installs(), 0);
  const newer = fixture();
  newer.version(30);
  await newer.updater.tick();
  assert.equal(newer.installs(), 0);
  const missing = fixture({ installedPackage: async () => null });
  await missing.updater.tick();
  assert.equal(missing.installs(), 0);
  assert.equal(missing.updater.status().devices[0].state, "not-installed");
});
test("install failure records error and retries with per-device exponential backoff", async () => {
  let attempts = 0;
  const f = fixture({
    installPackage: async () => {
      attempts++;
      throw Error("synthetic signature mismatch");
    },
  });
  await f.updater.tick();
  assert.equal(attempts, 1);
  assert.equal(f.updater.status().devices[0].failures, 1);
  assert.ok(f.events.some((e) => e[1] === "companion.update-failed"));
  f.advance(59000);
  await f.updater.tick();
  assert.equal(attempts, 1);
  f.advance(1001);
  await f.updater.tick();
  assert.equal(attempts, 2);
  assert.equal(f.updater.status().devices[0].nextAttemptAt, 1180001);
});
test("metadata download failure backs off without touching devices", async () => {
  let calls = 0;
  const f = fixture({
    getPackage: async () => {
      calls++;
      throw Error("synthetic network failure");
    },
  });
  await f.updater.tick();
  await f.updater.tick();
  assert.equal(calls, 1);
  assert.equal(f.installs(), 0);
  assert.ok(f.events.some((e) => e[1] === "companion.update-check-failed"));
  f.advance(300001);
  await f.updater.tick();
  assert.equal(calls, 2);
});
test("published APK checksum and package metadata are verified before installation", async () => {
  const bytes = apk(),
    checksum = createHash("sha256").update(bytes).digest("hex");
  const getRelease = async () => ({
    latestVersion: "0.10.0",
    assets: [
      { name: "Open-Deck-Android.apk", url: "https://example.invalid/app.apk" },
      { name: "SHA256SUMS.txt", url: "https://example.invalid/sums" },
    ],
  });
  const fetcher = async (url) =>
    new Response(
      url.endsWith("sums") ? `${checksum}  Open-Deck-Android.apk\n` : bytes,
    );
  const pkg = await downloadCompanionPackage({ getRelease, fetcher });
  assert.equal(pkg.versionCode, 20);
  assert.equal(pkg.checksum, checksum);
  await assert.rejects(
    downloadCompanionPackage({
      getRelease,
      fetcher: async (url) =>
        new Response(
          url.endsWith("sums")
            ? `${"0".repeat(64)}  Open-Deck-Android.apk\n`
            : bytes,
        ),
    }),
    /체크섬/,
  );
});
test("ADB install uses update mode only and cleans private temporary APK", async () => {
  const settings = { usb: { executablePath: "/bin/echo" } },
    bytes = apk(),
    pkg = {
      bytes,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      versionCode: 20,
      versionName: "0.10.0",
    };
  let tmp;
  const result = await installCompanionPackage(
    settings,
    "synthetic-device",
    pkg,
    {
      runner: async (file, args) => {
        assert.equal(file, "/bin/echo");
        assert.deepEqual(args.slice(0, 4), [
          "-s",
          "synthetic-device",
          "install",
          "-r",
        ]);
        tmp = args[4];
        assert.equal(fs.statSync(tmp).mode & 0o777, 0o600);
        return { stdout: "Success" };
      },
    },
  );
  assert.equal(result.versionCode, 20);
  assert.equal(fs.existsSync(tmp), false);
  const current = await installedCompanion(settings, "synthetic-device", {
    runner: async () => ({
      stdout: "versionCode=20 minSdk=26\nversionName=0.10.0\n",
    }),
  });
  assert.equal(current.versionCode, 20);
});
