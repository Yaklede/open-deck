import { editorLockStatus, showEditorLock } from "./editor-lock.mjs";
import { renderMigration } from "./migration-ui.mjs";
import { downloadFile } from "./downloads.mjs";
import { renderAccountSecurity, renderVaultSecurity } from "./security-ui.mjs";
import { t as translate, locales, setLocale, locale } from "./i18n.mjs";
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const native = (operation) =>
  window.webkit?.messageHandlers?.nativeSettings?.postMessage({ operation });
const labels = {
  appearance: ["화면 · 언어", "Appearance & language"],
  startup: ["Mac 시작 · Dock", "Mac startup & Dock"],
  devices: ["태블릿별 설정", "Device settings"],
  security: ["계정 · 보안", "Account & security"],
  network: ["네트워크 · USB", "Network & USB"],
  backups: ["백업 · 복원", "Backup & restore"],
  migration: ["Macro Deck", "Macro Deck"],
  diagnostics: ["진단 · 로그", "Diagnostics & logs"],
  about: ["앱 정보 · 업데이트", "About & updates"],
};
let activeAppearance = {};
let appearanceVariables = {};
export function applyAppearanceVariables(variables = {}) {
  appearanceVariables = variables;
  const value = activeAppearance.accentColor || "#a6acff";
  const binding = /^{{([a-zA-Z][a-zA-Z0-9_]*)}}$/.exec(value);
  const resolved = binding ? variables[binding[1]] : value;
  document.documentElement.style.setProperty(
    "--accent",
    /^#[a-f0-9]{6}([a-f0-9]{2})?$/i.test(resolved || "") ? resolved : "#a6acff",
  );
}
export async function applyAppearance(settings) {
  const a = settings?.appearance || {};
  activeAppearance = a;
  const mode =
    a.themeMode === "system"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : a.themeMode || "dark";
  document.documentElement.dataset.theme = mode;
  await setLocale(a.language || "system");
  applyAppearanceVariables(appearanceVariables);
  document.documentElement.style.setProperty(
    "--ui-scale",
    String((a.uiScale || 100) / 100),
  );
  document.body.dataset.font = a.fontFamily || "system";
  document.body.style.fontFamily = ["system", "sans", "mono"].includes(
    a.fontFamily || "system",
  )
    ? ""
    : JSON.stringify(a.fontFamily) + ", sans-serif";
  document.body.dataset.advanced =
    settings?.developer?.enabled === true ? "yes" : "no";
  document.body.dataset.timeFormat = a.timeFormat || "24h";
  document.body.dataset.palette = JSON.stringify(a.palette || []);
}
export function createSettingsCenter({
  api,
  getConfig,
  saveDraft,
  restored,
  notice,
  exportFile,
}) {
  let response,
    draft,
    active = "appearance",
    query = "",
    dialog,
    content,
    status,
    nav,
    dirty = false,
    language = "ko",
    renderGeneration = 0;
  const t = (ko, en) => translate(ko, en, language);
  const error = (e) => {
    if (!status) {
      notice(e.message || String(e), true);
      return;
    }
    status.textContent = e.message || String(e);
    status.className = "settings-status error";
  };
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      error(e);
    }
  };
  function action(parent, ko, en, fn, cls = "") {
    const b = el("button", t(ko, en), cls);
    b.type = "button";
    b.onclick = run(fn);
    parent.append(b);
    return b;
  }
  function row(parent, ko, en, value, onChange, options = {}) {
    const label = el("label", undefined, "settings-row");
    const description = el("span", undefined, "settings-label");
    description.append(el("strong", t(ko, en)));
    if (options.help) description.append(el("small", t(...options.help)));
    const input = el(options.choices ? "select" : "input");
    input.setAttribute("aria-label", t(ko, en));
    if (options.choices)
      for (const [value, names] of Object.entries(options.choices)) {
        const o = el("option", Array.isArray(names) ? t(...names) : names);
        o.value = value;
        input.append(o);
      }
    else input.type = options.type || "text";
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value ?? "";
    if (options.min !== undefined) input.min = options.min;
    if (options.max !== undefined) input.max = options.max;
    input.onchange = () => {
      onChange(
        input.type === "checkbox"
          ? input.checked
          : options.type === "number" || options.type === "range"
            ? Number(input.value)
            : input.value,
      );
      if (!options.transient) {
        dirty = true;
        status.textContent = t("저장하지 않은 변경", "Unsaved changes");
      }
    };
    label.append(description, input);
    parent.append(label);
    return input;
  }
  function section(ko, en) {
    const s = el("section", undefined, "settings-section");
    s.append(el("h3", t(ko, en)));
    content.append(s);
    return s;
  }
  function note(parent, ko, en) {
    parent.append(el("p", t(ko, en), "settings-note"));
  }
  function field(parent, group, key, ko, en, options) {
    return row(
      parent,
      ko,
      en,
      draft[group][key],
      (v) => {
        draft[group][key] = v;
        if (group === "appearance") applyAppearance(draft);
      },
      options,
    );
  }
  function textObject(parent, value) {
    const p = el("pre", JSON.stringify(value, null, 2), "settings-json");
    parent.append(p);
  }
  function categories() {
    nav.replaceChildren();
    for (const [id, names] of Object.entries(labels)) {
      const b = el("button", t(...names));
      b.classList.toggle("selected", active === id);
      b.onclick = () => {
        active = id;
        render();
      };
      nav.append(b);
    }
  }
  function passwordInput(title) {
    return new Promise((resolve) => {
      const prompt = el("dialog", undefined, "profile-dialog");
      prompt.append(el("h3", title));
      const input = el("input");
      input.type = "password";
      input.autocomplete = "new-password";
      input.setAttribute("aria-label", title);
      prompt.append(input);
      let submitted = false;
      action(
        prompt,
        "확인",
        "Confirm",
        () => {
          submitted = true;
          resolve(input.value);
          input.value = "";
          prompt.close();
        },
        "primary",
      );
      action(prompt, "취소", "Cancel", () => prompt.close());
      prompt.addEventListener("close", () => {
        if (!submitted) resolve(null);
        input.value = "";
        prompt.remove();
      });
      document.body.append(prompt);
      prompt.showModal();
      input.focus();
    });
  }
  async function render() {
    const generation = ++renderGeneration;
    content.replaceChildren();
    categories();
    const sectionName = t(...labels[active]);
    content.append(el("h2", sectionName));
    if (active === "migration")
      renderMigration({
        section,
        note,
        row,
        action,
        el,
        t,
        api,
        getConfig,
        restored,
      });
    if (active === "appearance") {
      const s = section("편집기 모양", "Editor appearance");
      field(s, "appearance", "themeMode", "색상 모드", "Color mode", {
        choices: {
          dark: ["어둡게", "Dark"],
          light: ["밝게", "Light"],
          system: ["시스템에 맞춤", "Follow system"],
        },
      });
      field(s, "appearance", "accentColor", "강조색", "Accent color", {
        help: [
          "#RRGGBB · #RRGGBBAA · {{variable}}",
          "#RRGGBB · #RRGGBBAA · {{variable}}",
        ],
      });
      const swatches = el("div", undefined, "settings-swatches");
      for (const color of draft.appearance.palette || []) {
        const b = el("button");
        b.title = color;
        b.setAttribute("aria-label", color);
        b.style.backgroundColor = color;
        b.onclick = async () => {
          draft.appearance.accentColor = color;
          dirty = true;
          await applyAppearance(draft);
          render();
        };
        swatches.append(b);
      }
      s.append(swatches);
      row(
        s,
        "저장한 색상 팔레트",
        "Saved color palette",
        (draft.appearance.palette || []).join(", "),
        (v) =>
          (draft.appearance.palette = v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)),
        {
          help: ["#RRGGBB / #RRGGBBAA · ≤24", "#RRGGBB / #RRGGBBAA · ≤24"],
        },
      );
      action(s, "초기화", "Reset", async () => {
        draft.appearance.palette = [];
        dirty = true;
        await applyAppearance(draft);
        await render();
      });
      field(s, "appearance", "fontFamily", "글꼴", "Font", {
        choices: {
          system: ["시스템", "System"],
          sans: ["산세리프", "Sans serif"],
          mono: ["고정폭", "Monospace"],
          ...Object.fromEntries(
            [
              ...(response.nativeStatus?.fontFamilies || []),
              draft.appearance.fontFamily,
            ]
              .filter(Boolean)
              .filter((v) => !["system", "sans", "mono"].includes(v))
              .map((v) => [v, v]),
          ),
        },
      });
      field(
        s,
        "appearance",
        "uiScale",
        "화면 크기 (%)",
        "Interface scale (%)",
        { type: "number", min: 80, max: 140 },
      );
      field(s, "appearance", "language", "설정 언어", "Settings language", {
        choices: Object.fromEntries(
          locales.map(({ code, name }) => [code, name]),
        ),
        help: [
          "설정 화면과 날짜 표시 언어에 적용됩니다. 사용자 버튼 이름은 유지됩니다.",
          "Applies to Settings and date display. Your button names stay as written.",
        ],
      });
      field(s, "appearance", "timeFormat", "시간 형식", "Time format", {
        choices: { "24h": ["24시간", "24-hour"], "12h": ["12시간", "12-hour"] },
      });
      note(
        s,
        "페이지별 테마·글자·배경은 덱 편집 → 페이지 디자인에서 따로 설정할 수 있어요.",
        "Page themes, text and backgrounds remain configurable in Deck editor → Page design.",
      );
    } else if (active === "startup") {
      const s = section("로그인할 때", "At login");
      field(
        s,
        "startup",
        "autostart",
        "Mac 로그인 시 자동 실행",
        "Launch at Mac login",
        { type: "checkbox" },
      );
      field(
        s,
        "startup",
        "openMinimized",
        "편집기 창을 숨긴 채 시작",
        "Start with editor hidden",
        { type: "checkbox" },
      );
      field(
        s,
        "startup",
        "showDockIcon",
        "Dock 아이콘 표시",
        "Show Dock icon",
        { type: "checkbox" },
      );
      note(
        s,
        "창을 닫아도 메뉴 막대에서 계속 실행됩니다. Dock을 숨겨도 메뉴 막대의 ◈에서 편집기를 열 수 있어요.",
        "Closing the window keeps Open Deck running in the menu bar. Use ◈ to reopen the editor even when its Dock icon is hidden.",
      );
      if (response.nativeStatus?.error)
        note(s, response.nativeStatus.error, response.nativeStatus.error);
    } else if (active === "network") {
      const s = section("Wi-Fi 연결", "Wi-Fi connection");
      field(s, "network", "wifiEnabled", "Wi-Fi 연결 허용", "Enable Wi-Fi", {
        type: "checkbox",
      });
      field(
        s,
        "network",
        "wifiPort",
        "공개 연결 포트",
        "Public connection port",
        {
          type: "number",
          min: 1024,
          max: 65535,
        },
      );
      field(
        s,
        "network",
        "tlsEnabled",
        "HTTPS 암호화 사용",
        "Enable HTTPS encryption",
        { type: "checkbox" },
      );
      field(s, "network", "tlsMode", "HTTPS 연결 방식", "HTTPS mode", {
        choices: {
          Replace: [
            "기본 포트를 HTTPS로 대체",
            "Replace public port with HTTPS",
          ],
          Additional: ["HTTP와 HTTPS 함께 사용", "HTTP and HTTPS together"],
        },
      });
      field(
        s,
        "network",
        "tlsHttpsPort",
        "추가 HTTPS 포트",
        "Additional HTTPS port",
        {
          type: "number",
          min: 1024,
          max: 65535,
          help: [
            "함께 사용 모드에서만 적용합니다.",
            "Used only in Additional mode.",
          ],
        },
      );
      field(
        s,
        "network",
        "discoveryEnabled",
        "로컬 네트워크에 호스트 알리기",
        "Advertise host on local network",
        { type: "checkbox" },
      );
      note(
        s,
        (response.network?.urls || []).join(" · ") || "현재 Wi-Fi 주소 없음",
        (response.network?.urls || []).join(" · ") ||
          "No Wi-Fi address available",
      );
      note(
        s,
        "기본값은 HTTPS입니다. 암호화를 끄거나 HTTP 병행을 선택하면 공개 HTTP 연결의 데이터가 암호화되지 않습니다. 태블릿도 비암호화 연결을 명시적으로 허용해야 사용합니다.",
        "HTTPS is the default. Disabling encryption or adding HTTP makes data on the public HTTP connection unencrypted. Tablets must explicitly allow unencrypted connections to use it.",
      );
      const certificate = section("Wi-Fi 인증서", "Wi-Fi certificate");
      action(
        certificate,
        "인증서 정보 확인",
        "Inspect certificate",
        async () => {
          const info = await api("/api/admin/certificate");
          certificate.querySelector("pre")?.remove();
          textObject(certificate, info);
        },
      );
      let certificatePem = "",
        privateKeyPem = "";
      for (const [label, isKey] of [
        [t("인증서 PEM 파일", "Certificate PEM file"), false],
        [t("개인 키 PEM 파일", "Private-key PEM file"), true],
      ]) {
        const line = el("label", label, "settings-row");
        const input = el("input");
        input.type = "file";
        input.accept = ".pem,.crt,.key";
        input.onchange = run(async () => {
          const file = input.files[0];
          if (file) {
            if (file.size > 128 * 1024)
              throw Error(
                t(
                  "인증서 파일이 너무 큽니다.",
                  "Certificate file is too large.",
                ),
              );
            if (isKey) privateKeyPem = await file.text();
            else certificatePem = await file.text();
          }
        });
        line.append(input);
        certificate.append(line);
      }
      action(certificate, "인증서 교체", "Replace certificate", async () => {
        if (!certificatePem || !privateKeyPem)
          throw Error(
            t(
              "인증서와 개인 키 파일을 모두 선택하세요.",
              "Choose both certificate and private-key files.",
            ),
          );
        if (
          !confirm(
            t(
              "인증서를 교체하면 태블릿을 USB로 연결해 신뢰 정보를 다시 받아야 합니다. 계속할까요?",
              "Replacing this certificate requires USB to refresh tablet trust. Continue?",
            ),
          )
        )
          return;
        await api("/api/admin/certificate", "POST", {
          certificatePem,
          privateKeyPem,
        });
        certificatePem = "";
        privateKeyPem = "";
        status.textContent = t(
          "인증서를 교체했습니다. USB로 신뢰 정보를 갱신하세요.",
          "Certificate replaced. Refresh tablet trust over USB.",
        );
      });
      for (const [operation, ko, en] of [
        [
          "issue-local-ca",
          "로컬 CA로 인증서 재발급",
          "Reissue certificate with local CA",
        ],
        [
          "regenerate-authority",
          "로컬 인증기관 재생성",
          "Regenerate local certificate authority",
        ],
      ]) {
        action(certificate, ko, en, async () => {
          if (
            !confirm(
              t(
                "신뢰 정보가 변경됩니다. 연결된 태블릿은 USB로 신뢰 정보를 다시 받아야 합니다. 계속할까요?",
                "Trust information will change. Connected tablets need USB to refresh trust. Continue?",
              ),
            )
          )
            return;
          const info = await api("/api/admin/certificate", "POST", {
            operation,
          });
          certificate.querySelector("pre")?.remove();
          textObject(certificate, info);
          status.textContent = t(
            "인증서를 발급했습니다. USB로 태블릿 신뢰 정보를 갱신하세요.",
            "Certificate issued. Refresh tablet trust over USB.",
          );
        });
      }
      action(
        certificate,
        "공개 CA 인증서 내보내기",
        "Export public CA certificate",
        async () => {
          const result = await api("/api/admin/certificate/authority");
          downloadFile(
            "Open-Deck-Local-Authority.pem",
            result.certificatePem,
            "application/x-pem-file",
          );
        },
      );
      const usb = section("USB · ADB", "USB · ADB");
      field(usb, "usb", "enabled", "USB 연결 사용", "Enable USB", {
        type: "checkbox",
      });
      field(
        usb,
        "usb",
        "stopServerOnExit",
        "앱 종료 시 ADB 서버 정지",
        "Stop ADB server when quitting",
        {
          type: "checkbox",
          help: [
            "켜면 다른 개발 도구가 공유하는 ADB 연결도 종료됩니다. 기본값은 끔입니다.",
            "Also stops ADB connections shared by other developer tools. Off by default.",
          ],
        },
      );
      field(
        usb,
        "usb",
        "companionAutoUpdate",
        "연결된 태블릿 앱 자동 업데이트",
        "Automatically update connected tablet apps",
        {
          type: "checkbox",
          help: [
            "Open Deck이 이미 설치된 ADB 기기만 업데이트합니다. 새 버전과 체크섬을 확인하며 기존 앱과 서명이 일치해야 설치됩니다. 기본값은 끔입니다.",
            "Only updates ADB devices that already have Open Deck. Checks the version and checksum; Android requires the existing app signature. Off by default.",
          ],
        },
      );
      field(
        usb,
        "usb",
        "autoConnect",
        "연결된 태블릿 자동 재연결",
        "Automatically reconnect attached tablets",
        { type: "checkbox" },
      );
      field(usb, "usb", "executablePath", "ADB 실행 파일", "ADB executable", {
        help: [
          "비워 두면 설치된 ADB를 자동으로 찾습니다.",
          "Leave blank to find an installed ADB automatically.",
        ],
      });
      field(
        usb,
        "usb",
        "defaultDeviceSerial",
        "기본 기기 일련번호",
        "Default device serial",
        {
          help: [
            "비워 두면 연결된 실제 기기를 모두 연결합니다.",
            "Leave blank to connect all attached physical devices.",
          ],
        },
      );
      action(usb, "USB 다시 연결", "Reconnect USB", async () => {
        await api("/api/admin/usb", "POST", { operation: "reconnect" });
        status.textContent = t(
          "USB 터널을 다시 연결했습니다.",
          "USB tunnels reconnected.",
        );
      });
      action(usb, "ADB 상태 확인", "Check ADB status", async () => {
        const adb = await api("/api/admin/usb");
        usb.querySelector(".settings-json")?.remove();
        textObject(usb, adb);
      });
      action(usb, "ADB 서버 시작", "Start ADB server", async () => {
        const adb = await api("/api/admin/usb", "POST", { operation: "start" });
        usb.querySelector(".settings-json")?.remove();
        textObject(usb, adb);
      });
      action(
        usb,
        "ADB 네트워크 기기 연결",
        "Connect network ADB device",
        async () => {
          const address = prompt(
            t("ADB 주소 (호스트:포트)", "ADB address (host:port)"),
            "",
          );
          if (address) {
            await api("/api/admin/usb", "POST", {
              operation: "connect",
              address,
            });
            status.textContent = t(
              "ADB 기기 연결 완료",
              "ADB device connected",
            );
          }
        },
      );
      action(usb, "ADB 서버 다시 시작", "Restart ADB server", async () => {
        if (
          !confirm(
            t(
              "공유 ADB 서버를 다시 시작하면 다른 개발 도구와 기기 연결도 잠시 끊깁니다. 계속할까요?",
              "Restarting the shared ADB server briefly disconnects other developer tools and devices. Continue?",
            ),
          )
        )
          return;
        const result = await api("/api/admin/usb", "POST", {
          operation: "restart",
        });
        usb.querySelector(".settings-json")?.remove();
        textObject(usb, result);
      });
      action(
        usb,
        "ADB 도구 다운로드·설치",
        "Download and install ADB tools",
        async () => {
          status.textContent = t(
            "공식 플랫폼 도구를 다운로드하고 검증하는 중…",
            "Downloading and verifying official platform tools…",
          );
          const result = await api("/api/admin/usb", "POST", {
            operation: "download",
          });
          draft.usb.executablePath = result.executablePath;
          await reload();
          status.textContent = t(
            "ADB 도구를 설치하고 연결 경로를 저장했습니다.",
            "ADB tools installed and connection path saved.",
          );
        },
      );
      const http = section("HTTP 요청", "HTTP requests");
      field(http, "http", "userAgent", "사용자 에이전트", "User agent", {
        help: [
          "비워 두면 Open Deck 기본값을 사용합니다.",
          "Leave blank to use the Open Deck default.",
        ],
      });
      action(usb, "연결 새로 고침", "Refresh connections", async () => {
        await api("/api/admin/resume", "POST", {});
        status.textContent = t("재연결 요청 완료", "Reconnection requested");
      });
    } else if (active === "security") {
      const securityContext = {
        api,
        section,
        note,
        action,
        row,
        t,
        passwordInput,
        reload,
        el,
        status,
        isCurrent: () => generation === renderGeneration,
      };
      await renderAccountSecurity(securityContext);
      if (generation !== renderGeneration) return;
      const accountStatus = await api("/api/admin/account");
      const lockStatus = await editorLockStatus();
      if (generation !== renderGeneration) return;
      const s = section("로컬 편집기 보호", "Protect the local editor");
      note(
        s,
        lockStatus.configured
          ? "편집기 암호가 설정되어 있습니다."
          : "편집기 암호를 설정하지 않았습니다.",
        lockStatus.configured
          ? "An editor password is configured."
          : "No editor password is configured.",
      );
      note(
        s,
        "잠금은 이 맥의 편집기와 설정 변경을 보호합니다. 태블릿의 버튼과 모니터링은 계속 동작합니다.",
        "Locking protects this Mac’s editor and settings. Tablet buttons and monitoring continue to work.",
      );
      draft.security ??= { idleLockMinutes: lockStatus.idleMinutes || 0 };
      field(
        s,
        "security",
        "idleLockMinutes",
        "자동 잠금 대기 (분, 0: 끔)",
        "Idle lock delay (minutes, 0: off)",
        { type: "number", min: 0, max: 120 },
      );
      if (!accountStatus.configured)
        action(
          s,
          lockStatus.configured ? "암호 변경" : "암호 설정",
          lockStatus.configured ? "Change password" : "Set password",
          async () => {
            let currentPassword;
            if (lockStatus.configured) {
              currentPassword = await passwordInput(
                t("현재 편집기 암호", "Current editor password"),
              );
              if (currentPassword === null) return;
            }
            const password = await passwordInput(
              t(
                "새 편집기 암호 (8자 이상)",
                "New editor password (8+ characters)",
              ),
            );
            if (password === null) return;
            if (password.length < 8)
              throw Error(
                t(
                  "암호는 8자 이상이어야 합니다.",
                  "Password must contain at least 8 characters.",
                ),
              );
            const confirmation = await passwordInput(
              t("새 암호 다시 입력", "Confirm new password"),
            );
            if (confirmation === null) return;
            if (password !== confirmation)
              throw Error(
                t(
                  "새 암호가 일치하지 않습니다.",
                  "New passwords do not match.",
                ),
              );
            await api("/api/admin/lock", "POST", {
              operation: "configure",
              password,
              currentPassword,
              idleMinutes: draft.security.idleLockMinutes,
            });
            await reload();
            status.textContent = t(
              "편집기 암호를 저장했습니다.",
              "Editor password saved.",
            );
          },
          "primary",
        );
      if (lockStatus.configured) {
        action(s, "지금 잠그기", "Lock now", async () => {
          await api("/api/admin/lock", "POST", { operation: "lock" });
          showEditorLock();
        });
        if (!accountStatus.configured)
          action(
            s,
            "편집기 암호 제거",
            "Remove editor password",
            async () => {
              const password = await passwordInput(
                t("편집기 암호", "Editor password"),
              );
              if (password === null) return;
              await api("/api/admin/lock", "POST", {
                operation: "disable",
                password,
              });
              await reload();
              status.textContent = t(
                "편집기 잠금을 껐습니다.",
                "Editor locking disabled.",
              );
            },
            "danger",
          );
      }
      await renderVaultSecurity(securityContext);
    } else if (active === "devices") {
      const data = await api("/api/admin/info");
      if (generation !== renderGeneration) return;
      const adbSection = section(
        "USB로 앱 설치 · 업데이트",
        "Install or update over USB",
      );
      action(
        adbSection,
        "연결된 Android 기기 확인",
        "Find attached Android devices",
        async () => {
          const adb = await api("/api/admin/usb");
          for (const d of adb.devices || []) {
            const r = el("div", undefined, "backup-row");
            r.append(el("strong", (d.model || d.serial) + " · " + d.state));
            action(r, "최신 APK 설치", "Install latest APK", async () => {
              if (
                !confirm(
                  t(
                    "이 기기에 최신 Open Deck 앱을 설치할까요? 설정은 유지됩니다.",
                    "Install the latest Open Deck app on this device? Settings are preserved.",
                  ),
                )
              )
                return;
              status.textContent = t(
                "서명된 APK를 확인하고 설치하는 중…",
                "Checking and installing the signed APK…",
              );
              await api("/api/admin/companion", "POST", { serial: d.serial });
              status.textContent = t(
                "앱 설치 완료",
                "App installation complete",
              );
            });
            adbSection.append(r);
          }
        },
      );
      if (!data.devices.length)
        note(
          content,
          "아직 페어링한 태블릿이 없어요.",
          "No paired tablets yet.",
        );
      for (const device of data.devices) {
        const s = section(device.name, device.name),
          ds = { ...(device.settings || {}) };
        const meta = el("div", undefined, "device-meta");
        meta.append(
          el(
            "span",
            device.online ? t("연결됨", "Online") : t("연결 대기", "Offline"),
            device.online ? "device-online" : "device-offline",
          ),
        );
        if (device.model) meta.append(el("span", device.model));
        if (device.appVersion)
          meta.append(el("span", "Open Deck " + device.appVersion));
        s.append(meta);
        let name = device.name;
        row(s, "기기 이름", "Device name", name, (v) => (name = v));
        let startSelect;
        row(
          s,
          "시작 프로필",
          "Startup profile",
          ds.profileId || "",
          (v) => {
            ds.profileId = v;
            ds.startPageId = "";
            if (startSelect) {
              startSelect.replaceChildren();
              const profile = getConfig().profiles.find(
                (p) => p.id === (v || getConfig().defaultProfileId),
              );
              for (const [id, name] of [
                ["", t("프로필 기본 페이지", "Profile default")],
                ...getConfig()
                  .pages.filter((p) => profile?.pageIds.includes(p.id))
                  .map((p) => [p.id, p.name]),
              ]) {
                const option = el("option", name);
                option.value = id;
                startSelect.append(option);
              }
            }
          },
          {
            choices: {
              "": ["기본 프로필", "Default profile"],
              ...Object.fromEntries(
                (getConfig().profiles || []).map((p) => [p.id, p.name]),
              ),
            },
          },
        );
        startSelect = row(
          s,
          "시작 페이지",
          "Startup page",
          ds.startPageId || "",
          (v) => (ds.startPageId = v),
          {
            choices: {
              "": ["프로필 기본 페이지", "Profile default"],
              ...Object.fromEntries(
                getConfig()
                  .pages.filter((p) =>
                    getConfig()
                      .profiles.find(
                        (x) =>
                          x.id ===
                          (ds.profileId || getConfig().defaultProfileId),
                      )
                      ?.pageIds.includes(p.id),
                  )
                  .map((p) => [p.id, p.name]),
              ),
            },
          },
        );
        for (const [key, ko, en, def] of [
          ["awake", "화면 켜짐 유지", "Keep screen awake", true],
          [
            "settingsButtonHidden",
            "설정 버튼 숨기기",
            "Hide settings button",
            false,
          ],
          ["showHeader", "상단 상태 표시", "Show status header", true],
          ["showNavigation", "하단 탭 표시", "Show bottom tabs", true],
          ["rememberPage", "마지막 페이지 기억", "Remember last page", true],
          ["haptics", "터치 진동", "Touch vibration", true],
          ["sound", "터치 소리", "Touch sound", false],
          ["swipeEnabled", "좌우 스와이프", "Page swipes", true],
          ["reducedMotion", "움직임 줄이기", "Reduce motion", false],
          ["osNotifications", "OS 알림", "OS notifications", true],
          ["monitorNotifications", "모니터 경고 알림", "Monitor alerts", true],
          ["fullscreen", "전체 화면", "Fullscreen", true],
          [
            "fixedVibration",
            "진동 시간 직접 설정",
            "Custom vibration duration",
            false,
          ],
          [
            "firstTouchWakes",
            "첫 터치는 화면만 깨우기",
            "First touch only wakes screen",
            true,
          ],
          [
            "notificationBanner",
            "앱 내 알림 배너",
            "In-app notification banner",
            true,
          ],
        ])
          row(s, ko, en, ds[key] ?? def, (v) => (ds[key] = v), {
            type: "checkbox",
          });
        row(
          s,
          "화면 방향",
          "Orientation",
          ds.orientation || "auto",
          (v) => (ds.orientation = v),
          {
            choices: {
              auto: ["자동", "Automatic"],
              landscape: ["가로", "Landscape"],
              portrait: ["세로", "Portrait"],
            },
          },
        );
        row(
          s,
          "앱 테마",
          "App theme",
          ds.theme || "dark",
          (v) => (ds.theme = v),
          {
            choices: {
              dark: ["어둡게", "Dark"],
              light: ["밝게", "Light"],
              system: ["시스템에 맞춤", "System"],
            },
          },
        );
        row(
          s,
          "렌더링 모드",
          "Rendering mode",
          ds.renderMode || "standard",
          (v) => (ds.renderMode = v),
          {
            choices: {
              standard: ["기본", "Standard"],
              simple: ["간소화", "Simple"],
            },
          },
        );
        row(
          s,
          "이미지 해상도",
          "Image resolution",
          String(ds.iconResolution || 0),
          (v) => (ds.iconResolution = Number(v)),
          {
            choices: {
              0: ["자동", "Automatic"],
              128: "128 px",
              256: "256 px",
              512: "512 px",
            },
          },
        );
        row(
          s,
          "시간 형식",
          "Time format",
          ds.timeFormat || "24h",
          (v) => (ds.timeFormat = v),
          {
            choices: {
              "24h": ["24시간", "24-hour"],
              "12h": ["12시간", "12-hour"],
            },
          },
        );
        row(
          s,
          "진동 길이 (ms)",
          "Vibration duration (ms)",
          ds.vibrationMs || 40,
          (v) => (ds.vibrationMs = v),
          { type: "number", min: 20, max: 200 },
        );
        row(
          s,
          "화면 보호 밝기 (%)",
          "Screensaver brightness (%)",
          ds.dimPercent || 10,
          (v) => (ds.dimPercent = v),
          { type: "number", min: 5, max: 50 },
        );
        row(
          s,
          "밝기 (−1: 시스템)",
          "Brightness (−1: system)",
          ds.brightness ?? -1,
          (v) => (ds.brightness = v),
          { type: "number", min: -1, max: 100 },
        );
        row(
          s,
          "글자 크기 (%)",
          "Text size (%)",
          ds.textScale ?? 100,
          (v) => (ds.textScale = v),
          { type: "number", min: 80, max: 160 },
        );
        row(
          s,
          "화면 보호 대기 (분, 0: 끔)",
          "Screensaver delay (minutes, 0: off)",
          ds.screenSaverMinutes || 0,
          (v) => (ds.screenSaverMinutes = v),
          { type: "number", min: 0, max: 120 },
        );
        row(
          s,
          "화면 보호 모드",
          "Screensaver mode",
          ds.screenSaverMode || "dim",
          (v) => (ds.screenSaverMode = v),
          { choices: { dim: ["어둡게", "Dim"], clock: ["시계", "Clock"] } },
        );
        const grouping = [
          {
            ko: "화면 · 성능",
            en: "Display & performance",
            labels: [
              "화면 켜짐 유지",
              "Keep screen awake",
              "상단 상태 표시",
              "Show status header",
              "전체 화면",
              "Fullscreen",
              "화면 방향",
              "Orientation",
              "앱 테마",
              "App theme",
              "렌더링 모드",
              "Rendering mode",
              "이미지 해상도",
              "Image resolution",
              "시간 형식",
              "Time format",
              "밝기 (−1: 시스템)",
              "Brightness (−1: system)",
              "글자 크기 (%)",
              "Text size (%)",
            ],
          },
          {
            ko: "터치 · 페이지 이동",
            en: "Touch & navigation",
            labels: [
              "설정 버튼 숨기기",
              "Hide settings button",
              "하단 탭 표시",
              "Show bottom tabs",
              "마지막 페이지 기억",
              "Remember last page",
              "터치 진동",
              "Touch vibration",
              "터치 소리",
              "Touch sound",
              "좌우 스와이프",
              "Page swipes",
              "움직임 줄이기",
              "Reduce motion",
              "진동 시간 직접 설정",
              "Custom vibration duration",
              "진동 길이 (ms)",
              "Vibration duration (ms)",
            ],
          },
          {
            ko: "화면 보호",
            en: "Screensaver",
            labels: [
              "첫 터치는 화면만 깨우기",
              "First touch only wakes screen",
              "화면 보호 밝기 (%)",
              "Screensaver brightness (%)",
              "화면 보호 대기 (분, 0: 끔)",
              "Screensaver delay (minutes, 0: off)",
              "화면 보호 모드",
              "Screensaver mode",
            ],
          },
          {
            ko: "알림",
            en: "Notifications",
            labels: [
              "OS 알림",
              "OS notifications",
              "모니터 경고 알림",
              "Monitor alerts",
              "앱 내 알림 배너",
              "In-app notification banner",
            ],
          },
        ];
        const deviceRows = [...s.querySelectorAll(":scope > .settings-row")];
        for (const group of grouping) {
          const details = el("details", undefined, "device-settings-group");
          details.append(el("summary", t(group.ko, group.en)));
          for (const deviceRow of deviceRows) {
            const label = deviceRow
              .querySelector("input,select")
              ?.getAttribute("aria-label");
            if (group.labels.includes(label)) details.append(deviceRow);
          }
          s.append(details);
        }
        note(
          s,
          "설정 버튼을 숨겨도 상단을 길게 눌러 다시 열 수 있어요.",
          "Long-press the top area to reopen Settings when its button is hidden.",
        );
        action(
          s,
          "기기에 적용",
          "Apply to device",
          async () => {
            await api("/api/admin/devices", "PUT", {
              id: device.id,
              name,
              settings: ds,
            });
            status.textContent = t(
              "태블릿에 적용했습니다.",
              "Applied to tablet.",
            );
            dirty = false;
          },
          "primary",
        );
        action(s, "화면 보호 지금 시작", "Start screensaver now", async () => {
          await api("/api/admin/devices/screensaver", "POST", {
            id: device.id,
          });
          status.textContent = t(
            "화면 보호를 시작했습니다.",
            "Screensaver requested.",
          );
        });
        action(
          s,
          "페어링 해제",
          "Remove pairing",
          async () => {
            if (
              !confirm(
                t(
                  "이 태블릿의 연결 권한을 해제할까요?",
                  "Remove this tablet’s pairing?",
                ),
              )
            )
              return;
            await api("/api/admin/revoke", "POST", { id: device.id });
            await render();
          },
          "danger",
        );
      }
    } else if (active === "backups") {
      await renderVaultSecurity(
        {
          api,
          section,
          note,
          action,
          row,
          t,
          passwordInput,
          reload,
          el,
          status,
          isCurrent: () => generation === renderGeneration,
        },
        { backup: true },
      );
      if (generation !== renderGeneration) return;
      const s = section("자동 백업", "Scheduled backups");
      field(
        s,
        "backups",
        "enabled",
        "자동 백업 켜기",
        "Enable scheduled backups",
        { type: "checkbox" },
      );
      field(
        s,
        "backups",
        "beforeUpdate",
        "앱 업데이트 전에 백업",
        "Back up before app updates",
        { type: "checkbox" },
      );
      field(s, "backups", "schedule", "백업 일정", "Schedule", {
        choices: {
          interval: ["시간 간격", "Interval"],
          daily: ["매일", "Daily"],
          weekly: ["매주", "Weekly"],
          monthly: ["매월", "Monthly"],
        },
      });
      field(s, "backups", "time", "백업 시각", "Backup time", { type: "time" });
      field(
        s,
        "backups",
        "dayOfWeek",
        "요일 (0: 일요일)",
        "Weekday (0: Sunday)",
        { type: "number", min: 0, max: 6 },
      );
      field(s, "backups", "dayOfMonth", "매월 날짜", "Day of month", {
        type: "number",
        min: 1,
        max: 28,
      });
      field(
        s,
        "backups",
        "intervalHours",
        "백업 간격 (시간)",
        "Interval (hours)",
        { type: "number", min: 1, max: 168 },
      );
      field(s, "backups", "retention", "보관할 백업 수", "Retained backups", {
        type: "number",
        min: 1,
        max: 100,
      });
      note(
        s,
        "백업은 이 맥에 보관됩니다. 복원 전에도 현재 설정을 백업합니다. 인증 토큰과 Mac 키체인 비밀은 포함하지 않습니다.",
        "Backups stay on this Mac. Current settings are backed up before restoration. Authentication tokens and Keychain secrets are excluded.",
      );
      action(s, "지금 백업", "Back up now", async () => {
        await saveDraft();
        await api("/api/admin/backups", "POST", { operation: "create" });
        await render();
      });
      const list = await api("/api/admin/backups");
      if (generation !== renderGeneration) return;
      const entries = section("저장된 백업", "Saved backups");
      if (!list.backups.length)
        note(entries, "아직 백업이 없습니다.", "No backups yet.");
      for (const backup of list.backups) {
        const r = el("div", undefined, "backup-row");
        r.append(
          el(
            "strong",
            new Date(backup.createdAt || backup.at || 0).toLocaleString(
              locale(),
            ),
          ),
        );
        r.append(
          el(
            "small",
            `${{ manual: t("수동 백업", "Manual backup"), scheduled: t("자동 백업", "Scheduled backup"), "before-restore": t("복원 전 백업", "Before restore"), imported: t("가져온 백업", "Imported backup") }[backup.reason] || t("백업", "Backup")} · ${Math.round((backup.sizeBytes || backup.bytes || backup.size || 0) / 1024)} KiB`,
          ),
        );
        if (backup.encrypted)
          r.append(
            el(
              "small",
              backup.locked
                ? t(
                    "암호화됨 · 저장소 잠금 해제 필요",
                    "Encrypted · unlock the vault to restore",
                  )
                : t("암호화됨", "Encrypted"),
            ),
          );
        action(r, "미리 보기", "Preview", async () => {
          const data = await api("/api/admin/backups", "POST", {
            operation: "preview",
            id: backup.id,
          });
          const preview = data.preview || data,
            counts = preview.counts || {};
          const summary = el("div", undefined, "backup-preview");
          summary.append(
            el(
              "strong",
              t(
                `프로필 ${counts.profiles ?? "—"} · 페이지 ${counts.pages ?? "—"} · 위젯 ${counts.widgets ?? "—"} · 이미지 ${counts.assets ?? "—"}`,
                `${counts.profiles ?? "—"} profiles · ${counts.pages ?? "—"} pages · ${counts.widgets ?? "—"} widgets · ${counts.assets ?? "—"} images`,
              ),
            ),
          );
          const profiles = el("ul");
          for (const profile of preview.profiles || [])
            profiles.append(
              el(
                "li",
                t(
                  `${profile.name} · ${profile.pageCount}페이지 · ${profile.widgetCount}개 위젯`,
                  `${profile.name} · ${profile.pageCount} pages · ${profile.widgetCount} widgets`,
                ),
              ),
            );
          summary.append(profiles);
          summary.append(
            el(
              "p",
              [
                preview.hasPreferences
                  ? t("앱 설정 포함", "App settings included")
                  : t("앱 설정 미포함", "No app settings"),
                preview.hasState
                  ? t(
                      "변수·할 일 실행 상태 포함",
                      "Variable and task state included",
                    )
                  : t("실행 상태 미포함", "No saved runtime state"),
              ].join(" · "),
            ),
          );
          r.querySelector(".backup-preview")?.remove();
          r.append(summary);
        });
        action(r, "복원", "Restore", async () => {
          if (
            !confirm(
              t(
                "이 백업으로 덱과 설정을 복원할까요? 현재 상태는 별도 백업됩니다.",
                "Restore this backup? The current state will be backed up first.",
              ),
            )
          )
            return;
          const preview = (
            await api("/api/admin/backups", "POST", {
              operation: "preview",
              id: backup.id,
            })
          ).preview;
          const select = prompt(
            t(
              "복원할 프로필 ID를 쉼표로 입력하세요. 비우면 전체를 복원합니다.\n",
              "Enter profile IDs separated by commas. Leave blank to restore all.\n",
            ) +
              (preview.profiles || [])
                .map((p) => `${p.name}: ${p.id}`)
                .join("\n"),
            "",
          );
          if (select === null) return;
          const restoreState = confirm(
            t(
              "변수 값과 로컬 할 일 상태도 복원할까요? 취소하면 현재 상태를 유지합니다.",
              "Also restore variable values and local tasks? Cancel keeps current state.",
            ),
          );
          const data = await api("/api/admin/backups", "POST", {
            operation: "restore",
            id: backup.id,
            profileIds: select.trim()
              ? select.split(",").map((x) => x.trim())
              : undefined,
            restoreState,
          });
          await restored(data.config);
          await reload();
          status.textContent = t("복원했습니다.", "Backup restored.");
        });
        action(r, "암호화 내보내기", "Encrypted export", async () => {
          const password = await passwordInput(
            t(
              "내보낼 백업 암호 (8자 이상)",
              "Password for exported backup (8+ characters)",
            ),
          );
          if (password === null) return;
          const result = await api("/api/admin/backups", "POST", {
            operation: "export",
            id: backup.id,
            password,
          });
          await exportFile(result.archive);
        });
        action(
          r,
          "복구 키로 보호해 내보내기",
          "Export protected by recovery key",
          async () => {
            const result = await api("/api/admin/backups", "POST", {
              operation: "export",
              id: backup.id,
              recoveryProtected: true,
            });
            await exportFile(result.archive);
          },
        );
        action(r, "파일 내보내기", "Export file", async () => {
          const result = await api("/api/admin/backups", "POST", {
            operation: "export",
            id: backup.id,
          });
          await exportFile(result.archive);
        });
        action(
          r,
          "삭제",
          "Delete",
          async () => {
            if (
              !confirm(t("이 백업 파일을 삭제할까요?", "Delete this backup?"))
            )
              return;
            await api("/api/admin/backups", "POST", {
              operation: "delete",
              id: backup.id,
            });
            await render();
          },
          "danger",
        );
        entries.append(r);
      }
      action(entries, "백업 파일 가져오기", "Import backup file", async () => {
        const picker = el("input");
        picker.type = "file";
        picker.accept = ".json,application/json";
        picker.onchange = run(async () => {
          const file = picker.files[0];
          if (!file) return;
          if (file.size > 96 * 1024 * 1024)
            throw Error(
              t("백업 파일이 너무 큽니다.", "Backup file is too large."),
            );
          const archive = JSON.parse(await file.text());
          let password;
          if (
            String(archive.kind || "").includes("encrypted") ||
            archive.encrypted ||
            archive.cipher
          ) {
            password = await passwordInput(
              archive.kind === "open-deck-backup-vault-encrypted"
                ? t("백업 복구 키", "Backup recovery key")
                : t("백업 암호", "Backup password"),
            );
            if (password === null) return;
          }
          await api("/api/admin/backups", "POST", {
            operation: "import",
            archive,
            password,
          });
          await render();
          status.textContent = t(
            "가져왔습니다. 미리 보기 후 복원하세요.",
            "Imported. Preview the backup before restoring.",
          );
        });
        picker.click();
      });
      action(entries, "백업 폴더 열기", "Open backup folder", () =>
        native("openBackups"),
      );
    } else if (active === "diagnostics") {
      const s = section("기록 설정", "Logging");
      field(
        s,
        "logging",
        "minimumLevel",
        "최소 로그 수준",
        "Minimum log level",
        {
          choices: {
            debug: "Debug",
            info: "Info",
            warn: "Warning",
            error: "Error",
          },
        },
      );
      field(
        s,
        "developer",
        "enabled",
        "고급 동작 JSON 표시",
        "Show advanced action JSON",
        { type: "checkbox" },
      );
      action(s, "데이터 폴더 열기", "Open data folder", () =>
        native("openDataDirectory"),
      );
      action(s, "로그 폴더 열기", "Open logs folder", () => native("openLogs"));
      let data = await api("/api/admin/diagnostics");
      if (generation !== renderGeneration) return;
      const overview = section("연결 요약", "Connection summary"),
        summary = el("div", undefined, "diagnostic-summary");
      overview.append(summary);
      const logs = section("실시간 로그", "Live logs"),
        controls = el("div", undefined, "log-controls");
      const level = el("select");
      level.setAttribute("aria-label", t("로그 수준 필터", "Log level filter"));
      for (const [value, label] of [
        ["", t("모든 수준", "All levels")],
        ["debug", "Debug"],
        ["info", "Info"],
        ["warn", "Warning"],
        ["error", "Error"],
      ]) {
        const option = el("option", label);
        option.value = value;
        level.append(option);
      }
      const search = el("input");
      search.type = "search";
      search.placeholder = t("이벤트·메시지 검색", "Search events or messages");
      search.setAttribute("aria-label", t("로그 검색", "Search logs"));
      const autoLabel = el("label", t("자동 갱신", "Auto-refresh")),
        auto = el("input");
      auto.type = "checkbox";
      auto.checked = true;
      autoLabel.prepend(auto);
      controls.append(level, search, autoLabel);
      logs.append(controls);
      const scroll = el("div", undefined, "log-table-scroll"),
        table = el("table", undefined, "log-table"),
        thead = el("thead"),
        heading = el("tr"),
        tbody = el("tbody");
      for (const label of [
        t("시각", "Time"),
        t("수준", "Level"),
        t("이벤트", "Event"),
        t("상세", "Details"),
      ])
        heading.append(el("th", label));
      thead.append(heading);
      table.append(thead, tbody);
      scroll.append(table);
      logs.append(scroll);
      const count = el("p", "", "settings-note");
      logs.append(count);
      const renderLogRows = () => {
        summary.replaceChildren();
        for (const [label, value] of [
          [
            t("연결된 화면", "Connected views"),
            (data.connections || []).length,
          ],
          [t("자동 복구", "Recoveries"), data.recovery?.count ?? 0],
          [
            t("실행 시간", "Uptime"),
            Math.floor((data.uptimeSeconds || 0) / 60) + t("분", " min"),
          ],
        ]) {
          const item = el("div");
          item.append(el("strong", String(value)), el("span", label));
          summary.append(item);
        }
        const term = search.value.toLocaleLowerCase(),
          rows = (data.logs || [])
            .filter(
              (entry) =>
                (!level.value || entry.level === level.value) &&
                (!term ||
                  JSON.stringify(entry).toLocaleLowerCase().includes(term)),
            )
            .slice()
            .reverse();
        tbody.replaceChildren();
        for (const entry of rows) {
          const tr = el("tr"),
            at = el(
              "td",
              new Date(entry.at).toLocaleTimeString(locale(), {
                hour12: draft.appearance.timeFormat === "12h",
              }),
            ),
            badge = el(
              "span",
              String(entry.level).toUpperCase(),
              "log-level " + entry.level,
            ),
            levelCell = el("td"),
            event = el("td", entry.event);
          levelCell.append(badge);
          const details = Object.entries(entry)
            .filter(([key]) => !["at", "level", "event"].includes(key))
            .map(([key, value]) => key + ": " + value)
            .join(" · ");
          tr.append(at, levelCell, event, el("td", details || "—"));
          tbody.append(tr);
        }
        count.textContent = t(
          `${rows.length}개 표시 · ${new Date().toLocaleTimeString("ko-KR")} 갱신`,
          `${rows.length} entries · updated ${new Date().toLocaleTimeString("en-US")}`,
        );
        if (!rows.length) {
          const tr = el("tr"),
            cell = el(
              "td",
              t("조건에 맞는 로그가 없습니다.", "No logs match these filters."),
            );
          cell.colSpan = 4;
          tr.append(cell);
          tbody.append(tr);
        }
      };
      level.onchange = renderLogRows;
      search.oninput = renderLogRows;
      renderLogRows();
      const refresh = async () => {
        const latest = await api("/api/admin/diagnostics");
        if (generation !== renderGeneration || !dialog.open) return;
        data = latest;
        renderLogRows();
      };
      const refreshLoop = async () => {
        if (generation !== renderGeneration || !dialog.open) return;
        try {
          if (auto.checked) await refresh();
        } catch (e) {
          error(e);
        }
        if (generation === renderGeneration && dialog.open)
          setTimeout(refreshLoop, 5000);
      };
      setTimeout(refreshLoop, 5000);
      action(content, "진단 내보내기", "Export diagnostics", () =>
        exportFile(data),
      );
      action(content, "다시 확인", "Refresh", refresh);
      if (draft.developer.enabled) {
        const advanced = el("details");
        advanced.append(
          el("summary", t("고급 진단 JSON", "Advanced diagnostics JSON")),
        );
        textObject(advanced, data);
        content.append(advanced);
      }
    } else if (active === "about") {
      const s = section("Open Deck", "Open Deck");
      s.append(
        el(
          "div",
          response.buildInfo?.version || response.version || "—",
          "settings-version",
        ),
      );
      if (response.buildInfo) {
        const build = response.buildInfo;
        note(
          s,
          `빌드 ${build.build ?? "—"} · 소스 ${String(build.commit || "—").slice(0, 12)}`,
          `Build ${build.build ?? "—"} · source ${String(build.commit || "—").slice(0, 12)}`,
        );
      }
      note(
        s,
        "macOS 호스트 + Android 태블릿 · MIT 오픈소스",
        "macOS host + Android tablet · MIT open source",
      );
      action(s, "업데이트 확인", "Check for updates", async () => {
        const latest = await api("/api/admin/update");
        s.querySelector(".update-result")?.remove();
        const result = el("div", undefined, "update-result");
        s.append(result);
        if (latest.error) throw Error(latest.error);
        note(
          result,
          `최신 버전: ${latest.latestVersion || latest.version || latest.tagName || latest.tag_name || "—"}`,
          `Latest version: ${latest.latestVersion || latest.version || latest.tagName || latest.tag_name || "—"}`,
        );
        const url = latest.url || latest.html_url;
        if (url && /^https:\/\/github\.com\/Yaklede\/open-deck\//.test(url)) {
          const a = el(
            "a",
            t("릴리즈와 설치 파일 열기", "Open release & installers"),
          );
          a.href = url;
          a.target = "_blank";
          a.rel = "noreferrer";
          a.onclick = (event) => {
            event.preventDefault();
            run(async () => {
              await api("/api/admin/update/prepare", "POST", {});
              if (window.webkit?.messageHandlers?.nativeSettings) {
                window.webkit.messageHandlers.nativeSettings.postMessage({
                  operation: "openRelease",
                  url,
                });
              } else window.location.assign(url);
            })();
          };
          result.append(a);
        }
        for (const asset of latest.assets || [])
          result.append(el("p", asset.name));
      });
      const notices = section("오픈소스 라이선스", "Open-source notices");
      const licenses = await api("/api/admin/licenses");
      if (generation !== renderGeneration) return;
      for (const license of licenses.licenses || []) {
        const item = el("details", undefined, "license-notice");
        item.append(el("summary", `${license.name} · ${license.license}`));
        if (license.text) item.append(el("pre", license.text));
        if (license.url && /^https:\/\//.test(license.url)) {
          const link = el("a", t("원문 열기", "Open source notice"));
          link.href = license.url;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.onclick = (event) => {
            if (window.webkit?.messageHandlers?.nativeSettings) {
              event.preventDefault();
              window.webkit.messageHandlers.nativeSettings.postMessage({
                operation: "openLicense",
                url: license.url,
              });
            }
          };
          item.append(link);
        }
        notices.append(item);
      }
    }
    filter();
  }
  function filter() {
    const term = query.trim().toLocaleLowerCase();
    for (const s of content.querySelectorAll(".settings-section"))
      s.hidden =
        Boolean(term) && !s.textContent.toLocaleLowerCase().includes(term);
  }
  async function reload() {
    response = await api("/api/admin/settings");
    draft = structuredClone(response.settings);
    language = draft.appearance.language;
    dirty = false;
    await applyAppearance(draft);
    await render();
  }
  async function open(category = "appearance") {
    active = labels[category] ? category : "appearance";
    if (dialog?.open) {
      await render();
      return;
    }
    dialog = el("dialog", undefined, "settings-dialog");
    dialog.setAttribute(
      "aria-label",
      t("Open Deck 설정", "Open Deck settings"),
    );
    const head = el("div", undefined, "settings-head");
    head.append(
      el(
        "div",
        t("Open Deck · 설정", "Open Deck · Settings"),
        "settings-title",
      ),
    );
    const search = el("input");
    search.type = "search";
    search.placeholder = "이 페이지 설정 검색 / Search settings";
    search.setAttribute("aria-label", "설정 검색");
    search.oninput = () => {
      query = search.value;
      filter();
    };
    head.append(search);
    const close = el("button", "✕");
    close.setAttribute("aria-label", "닫기");
    close.onclick = () => {
      if (
        !dirty ||
        confirm(
          t("저장하지 않은 설정을 버릴까요?", "Discard unsaved settings?"),
        )
      )
        dialog.close();
    };
    head.append(close);
    dialog.append(head);
    const body = el("div", undefined, "settings-body");
    nav = el("nav", undefined, "settings-nav");
    content = el("div", undefined, "settings-content");
    body.append(nav, content);
    dialog.append(body);
    const footer = el("div", undefined, "settings-footer");
    status = el("span", "", "settings-status");
    status.setAttribute("role", "status");
    footer.append(status);
    action(footer, "변경 취소", "Discard changes", () => reload());
    action(
      footer,
      "설정 저장",
      "Save settings",
      async () => {
        const r = await api("/api/admin/settings", "PUT", draft);
        draft = r.settings || draft;
        response.settings = draft;
        language = draft.appearance.language;
        dirty = false;
        await applyAppearance(draft);
        native("applySettings");
        await render();
        status.textContent = t("설정을 저장했습니다.", "Settings saved.");
      },
      "primary",
    );
    dialog.append(footer);
    dialog.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        footer.querySelector("button.primary")?.click();
      }
    });
    dialog.addEventListener("cancel", (e) => {
      if (
        dirty &&
        !confirm(
          t("저장하지 않은 설정을 버릴까요?", "Discard unsaved settings?"),
        )
      )
        e.preventDefault();
    });
    dialog.addEventListener("close", () => {
      applyAppearance(response?.settings);
      dialog.remove();
      query = "";
    });
    document.body.append(dialog);
    dialog.showModal();
    await reload();
  }
  return {
    open: run(() => open()),
    openCategory: (category) => run(() => open(category))(),
    initialize: async () => {
      response = await api("/api/admin/settings");
      await applyAppearance(response.settings);
      matchMedia("(prefers-color-scheme: light)").addEventListener(
        "change",
        () => applyAppearance(response.settings),
      );
    },
  };
}
