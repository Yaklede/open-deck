import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { releaseInfo } from "./settings.mjs";
const exec = promisify(execFile);
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
export async function installCompanion(settings, serial) {
  const status = await adbStatus(settings);
  if (!status.devices.some((d) => d.serial === serial && d.state === "device"))
    throw Error("연결된 Android 기기를 선택하세요.");
  const release = await releaseInfo();
  const apk = release.assets.find((a) => a.name === "Open-Deck-Android.apk"),
    sums = release.assets.find((a) => a.name === "SHA256SUMS.txt");
  if (!apk || !sums) throw Error("릴리즈 설치 파일이 없습니다.");
  const download = async (url, limit) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw Error("설치 파일 다운로드 실패");
    const reader = r.body.getReader();
    const chunks = [];
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
  if (!/^[0-9a-f]{64}$/.test(expected || ""))
    throw Error("APK 체크섬 정보가 없습니다.");
  const bytes = await download(apk.url, 100 * 1024 * 1024);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw Error("APK 체크섬 검증 실패");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-apk-"));
  try {
    const file = path.join(tmp, "Open-Deck.apk");
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const { stdout } = await exec(
      status.executablePath,
      ["-s", serial, "install", "-r", file],
      { timeout: 90000, maxBuffer: 1024 * 1024 },
    );
    if (!stdout.includes("Success"))
      throw Error("기기에서 APK 설치를 완료하지 못했습니다.");
    return { ok: true, version: release.latestVersion };
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
