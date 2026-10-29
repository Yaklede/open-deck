import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { releaseInfo } from "./settings.mjs";
import { readZip, safeArchivePath } from "./safe-zip.mjs";
import { apkManifest } from "./companion-update.mjs";
const exec = promisify(execFile);
export const PLATFORM_TOOLS_MANIFEST =
  "https://dl.google.com/android/repository/repository2-1.xml";
const installingTools = new Set();
export function platformToolsPackage(xml, platform = process.platform) {
  if (platform !== "darwin")
    throw Error("현재 자동 설치는 macOS에서 지원됩니다.");
  if (
    typeof xml !== "string" ||
    xml.length > 8 * 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw Error("Android 도구 목록을 확인할 수 없습니다.");
  const pkg = [
    ...xml.matchAll(
      /<remotePackage\b[^>]*path="platform-tools"[^>]*>([\s\S]*?)<\/remotePackage>/g,
    ),
  ]
    .map((m) => m[1])
    .find((s) => !/<channelRef\b[^>]*ref="(?!channel-0)[^"]+"/.test(s));
  const archive =
    pkg &&
    [...pkg.matchAll(/<archive>([\s\S]*?)<\/archive>/g)]
      .map((m) => m[1])
      .find((s) => /<host-os>macosx<\/host-os>/.test(s));
  const complete = archive?.match(/<complete>([\s\S]*?)<\/complete>/)?.[1];
  const url = complete?.match(/<url>([^<]+)<\/url>/)?.[1];
  const checksum = complete?.match(
    /<checksum(?:\s+type="(sha1|sha256)")?\s*>([a-fA-F0-9]+)<\/checksum>/,
  );
  if (checksum) checksum[1] ||= "sha1"; // Google's repository XML schema defaults to SHA-1.
  const size = Number(complete?.match(/<size>(\d+)<\/size>/)?.[1]);
  if (
    !url ||
    !/^platform-tools_r[\w.\-]+-darwin\.zip$/.test(url) ||
    !checksum ||
    checksum[2].length !== (checksum[1] === "sha1" ? 40 : 64) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 128 * 1024 * 1024
  )
    throw Error("공식 도구 URL·크기·체크섬을 확인할 수 없습니다.");
  const revision = pkg.match(/<revision>([\s\S]*?)<\/revision>/)?.[1] || "";
  const version = ["major", "minor", "micro"]
    .map((k) => revision.match(new RegExp(`<${k}>(\\d+)</${k}>`))?.[1] || "0")
    .join(".");
  return {
    url: "https://dl.google.com/android/repository/" + url,
    version,
    size,
    checksum: checksum[2].toLowerCase(),
    checksumAlgorithm: checksum[1],
  };
}
async function officialDownload(fetcher, url, limit) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://dl.google.com" ||
    !parsed.pathname.startsWith("/android/repository/")
  )
    throw Error("공식 Android 다운로드 주소가 아닙니다.");
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok || response.redirected)
    throw Error("Android 도구 다운로드에 실패했습니다.");
  const reader = response.body.getReader(),
    chunks = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > limit) throw Error("다운로드 크기 제한을 넘었습니다.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export async function downloadPlatformTools(
  dir,
  { fetcher = fetch, platform = process.platform } = {},
) {
  const root = path.resolve(dir),
    parent = path.join(root, "platform-tools");
  if (installingTools.has(root))
    throw Error("Android 도구를 이미 설치 중입니다.");
  installingTools.add(root);
  let staging;
  try {
    for (const location of [root, parent]) {
      if (!fs.existsSync(location)) fs.mkdirSync(location, { mode: 0o700 });
      const st = fs.lstatSync(location);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw Error("도구 설치 폴더를 확인하세요.");
    }
    const manifest = (
        await officialDownload(
          fetcher,
          PLATFORM_TOOLS_MANIFEST,
          8 * 1024 * 1024,
        )
      ).toString("utf8"),
      pkg = platformToolsPackage(manifest, platform);
    const bytes = await officialDownload(fetcher, pkg.url, pkg.size);
    if (
      bytes.length !== pkg.size ||
      createHash(pkg.checksumAlgorithm).update(bytes).digest("hex") !==
        pkg.checksum
    )
      throw Error("Android 도구 체크섬 검증에 실패했습니다.");
    const entries = readZip(bytes, {
      maxArchiveBytes: 128 * 1024 * 1024,
      maxBytes: 384 * 1024 * 1024,
      maxEntryBytes: 128 * 1024 * 1024,
      maxEntries: 1000,
    });
    if (!entries.has("platform-tools/adb"))
      throw Error("공식 도구 압축 파일에 ADB가 없습니다.");
    for (const name of entries.keys())
      if (name !== "platform-tools/" && !name.startsWith("platform-tools/"))
        throw Error("예상하지 못한 Android 도구 경로입니다.");
    staging = fs.mkdtempSync(path.join(parent, ".install-"));
    for (const [name, entry] of entries) {
      const destination = path.join(staging, safeArchivePath(name));
      if (entry.directory) {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        continue;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, entry.bytes, {
        flag: "wx",
        mode:
          entry.mode & 0o111 || name === "platform-tools/adb" ? 0o700 : 0o600,
      });
    }
    const final = path.join(
        parent,
        `${pkg.version}-${pkg.checksum.slice(0, 16)}`,
      ),
      executablePath = path.join(final, "platform-tools", "adb");
    if (fs.existsSync(final)) {
      for (const location of [
        final,
        path.dirname(executablePath),
        executablePath,
      ])
        if (fs.lstatSync(location).isSymbolicLink())
          throw Error("설치된 도구 경로를 확인하세요.");
      if (
        !fs
          .readFileSync(executablePath)
          .equals(entries.get("platform-tools/adb").bytes)
      )
        throw Error("기존 도구 파일이 변경되어 자동 교체하지 않았습니다.");
    } else {
      fs.renameSync(staging, final);
      staging = null;
    }
    return {
      ok: true,
      executablePath,
      version: pkg.version,
      checksum: pkg.checksum,
      checksumAlgorithm: pkg.checksumAlgorithm,
      source: pkg.url,
    };
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    installingTools.delete(root);
  }
}
export function adbPath(settings) {
  const configured = settings.usb.executablePath;
  const candidates = configured
    ? [configured]
    : [
        "/opt/homebrew/bin/adb",
        "/usr/local/bin/adb",
        path.join(os.homedir(), "Library/Android/sdk/platform-tools/adb"),
      ];
  return (
    candidates.find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }) || ""
  );
}
export async function adbStatus(settings) {
  const executablePath = adbPath(settings);
  if (!executablePath)
    return {
      available: false,
      devices: [],
      error: "ADB 실행 파일을 찾을 수 없습니다.",
    };
  try {
    const [{ stdout: version }, { stdout: raw }] = await Promise.all([
      exec(executablePath, ["version"], { timeout: 5000 }),
      exec(executablePath, ["devices", "-l"], { timeout: 5000 }),
    ]);
    const devices = raw
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state, ...tags] = l.split(/\s+/);
        return {
          serial,
          state,
          model: tags.find((t) => t.startsWith("model:"))?.slice(6) || "",
          isDefault: serial === settings.usb.defaultDeviceSerial,
        };
      });
    return {
      available: true,
      executablePath,
      version: version.split("\n")[0],
      devices,
    };
  } catch {
    return {
      available: true,
      executablePath,
      devices: [],
      error: "ADB 응답을 확인하지 못했습니다.",
    };
  }
}
export async function adbOperation(settings, input) {
  const executable = adbPath(settings);
  if (!executable) throw Error("ADB 경로를 먼저 설정하세요.");
  if (input.operation === "connect") {
    if (
      typeof input.address !== "string" ||
      !/^([a-zA-Z0-9.-]+|\[[0-9a-f:]+\]):\d{1,5}$/.test(input.address)
    )
      throw Error("호스트:포트 형식으로 입력하세요.");
    const { stdout } = await exec(executable, ["connect", input.address], {
      timeout: 10000,
    });
    if (!/connected to|already connected to/.test(stdout))
      throw Error(
        "무선 ADB 연결에 실패했습니다. 기기의 무선 디버깅을 확인하세요.",
      );
  } else if (input.operation === "reconnect") {
    const status = await adbStatus(settings);
    const serial = input.serial || settings.usb.defaultDeviceSerial;
    const targets = status.devices.filter(
      (d) => d.state === "device" && (!serial || d.serial === serial),
    );
    if (!targets.length) throw Error("연결할 수 있는 USB 기기가 없습니다.");
    for (const d of targets)
      await exec(
        executable,
        ["-s", d.serial, "reverse", "tcp:8840", "tcp:8840"],
        { timeout: 5000 },
      );
  } else if (input.operation === "restart") {
    await exec(executable, ["kill-server"], { timeout: 10000 });
    await exec(executable, ["start-server"], { timeout: 10000 });
  } else if (input.operation === "start")
    await exec(executable, ["start-server"], { timeout: 10000 });
  else throw Error("지원하지 않는 USB 작업입니다.");
  return adbStatus(settings);
}
export async function downloadCompanionPackage({
  fetcher = fetch,
  getRelease = releaseInfo,
} = {}) {
  const release = await getRelease();
  const apk = release.assets.find((a) => a.name === "Open-Deck-Android.apk"),
    sums = release.assets.find((a) => a.name === "SHA256SUMS.txt");
  if (!apk || !sums) throw Error("릴리즈 설치 파일이 없습니다.");
  const download = async (url, limit) => {
    const r = await fetcher(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw Error("설치 파일 다운로드 실패");
    const reader = r.body.getReader(),
      chunks = [];
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > limit) throw Error("설치 파일 크기를 확인하세요.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  };
  const manifest = (await download(sums.url, 65536)).toString("utf8");
  const expected = manifest
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find((p) => p[1] === "Open-Deck-Android.apk")?.[0];
  if (!/^[a-f0-9]{64}$/.test(expected || ""))
    throw Error("APK 체크섬 정보가 없습니다.");
  const bytes = await download(apk.url, 100 * 1024 * 1024);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw Error("APK 체크섬 검증 실패");
  return {
    bytes,
    checksum: expected,
    releaseVersion: release.latestVersion,
    ...apkManifest(bytes),
  };
}
export async function installedCompanion(
  settings,
  serial,
  { runner = exec } = {},
) {
  const executable = adbPath(settings);
  if (!executable) throw Error("ADB 경로를 먼저 설정하세요.");
  const { stdout } = await runner(
    executable,
    ["-s", serial, "shell", "dumpsys", "package", "app.opendeck.client"],
    { timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
  );
  const versionCode = Number(stdout.match(/\bversionCode=(\d+)/)?.[1]);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) return null;
  return {
    packageName: "app.opendeck.client",
    versionCode,
    versionName: stdout.match(/\bversionName=([^\r\n]+)/)?.[1]?.trim() || "",
  };
}
export async function installCompanionPackage(
  settings,
  serial,
  pkg,
  { runner = exec } = {},
) {
  const executable = adbPath(settings);
  if (!executable) throw Error("ADB 경로를 먼저 설정하세요.");
  if (
    !pkg?.bytes ||
    createHash("sha256").update(pkg.bytes).digest("hex") !== pkg.checksum
  )
    throw Error("APK 체크섬 검증 실패");
  const metadata = apkManifest(pkg.bytes);
  if (metadata.versionCode !== pkg.versionCode)
    throw Error("APK 버전 정보를 확인하세요.");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-apk-"));
  fs.chmodSync(tmp, 0o700);
  try {
    const file = path.join(tmp, "Open-Deck.apk");
    fs.writeFileSync(file, pkg.bytes, { mode: 0o600 });
    // Android checks that an update is signed by the installed app's signer. Never use -d or uninstall.
    const { stdout } = await runner(
      executable,
      ["-s", serial, "install", "-r", file],
      { timeout: 90000, maxBuffer: 1024 * 1024 },
    );
    if (!stdout.includes("Success"))
      throw Error("기기에서 APK 설치를 완료하지 못했습니다.");
    return {
      ok: true,
      version: pkg.releaseVersion || pkg.versionName,
      versionCode: pkg.versionCode,
    };
  } catch (e) {
    throw Error(
      e.message?.startsWith("기기에서")
        ? e.message
        : "Android 설치 실패: 기기 권한·저장 공간·기존 앱 서명을 확인하세요.",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
export async function installCompanion(settings, serial) {
  const status = await adbStatus(settings);
  if (!status.devices.some((d) => d.serial === serial && d.state === "device"))
    throw Error("연결된 Android 기기를 선택하세요.");
  return installCompanionPackage(
    settings,
    serial,
    await downloadCompanionPackage(),
  );
}
