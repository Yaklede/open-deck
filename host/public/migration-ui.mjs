import { downloadFile } from "./downloads.mjs";

export function renderMigration({
  section,
  note,
  row: settingsRow,
  action,
  el,
  t,
  api,
  getConfig,
  restored,
}) {
  const row = (parent, ko, en, value, change, options = {}) =>
    settingsRow(parent, ko, en, value, change, { ...options, transient: true });
  const inputSection = section("가져오기", "Import");
  note(
    inputSection,
    "Macro Deck 3 프로필·폴더·버튼·백업 및 Macro Deck 2 프로필을 가져옵니다. 미리보기에서 제외 항목을 확인하세요. 기존 프로필은 유지됩니다.",
    "Import Macro Deck 3 profiles, folders, widgets and backups, or Macro Deck 2 profiles. Review excluded items in the preview. Existing profiles are preserved.",
  );
  const file = el("input");
  file.type = "file";
  file.accept =
    ".macroDeckProfile,.macroDeckFolder,.macroDeckWidget,.macroDeckBackup,.json,.zip";
  file.setAttribute("aria-label", t("가져오기 파일", "Import file"));
  inputSection.append(file);
  let password = "",
    recoveryKey = "",
    previewId;
  const passwordField = row(
    inputSection,
    "암호",
    "Password",
    "",
    (value) => {
      password = value;
      previewId = undefined;
    },
    { type: "password" },
  );
  const recoveryField = row(
    inputSection,
    "복구 키",
    "Recovery key",
    "",
    (value) => {
      recoveryKey = value;
      previewId = undefined;
    },
    { type: "password" },
  );
  const result = el("div"),
    status = el("p", "", "settings-status");
  const reports = (data, target) => {
    target.replaceChildren();
    if (data.summary)
      target.append(
        el(
          "p",
          `${t("프로필", "Profiles")} ${data.summary.profiles} · ${t("페이지", "Pages")} ${data.summary.pages} · ${t("버튼", "Widgets")} ${data.summary.widgets}`,
        ),
      );
    if (data.report?.length) {
      const list = el("ul");
      for (const report of data.report)
        list.append(el("li", `${report.location} — ${report.detail}`));
      target.append(list);
    }
  };
  file.onchange = () => {
    previewId = undefined;
    result.replaceChildren();
    importButton.disabled = true;
  };
  action(inputSection, "미리보기", "Preview", async () => {
    const selected = file.files[0];
    if (!selected || selected.size > 64 * 1024 * 1024)
      throw Error(
        t("64 MiB 이하 파일을 선택하세요.", "Select a file up to 64 MiB."),
      );
    status.textContent = t("불러오는 중", "Loading");
    importButton.disabled = true;
    const bytes = new Uint8Array(await selected.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    try {
      const data = await api("/api/admin/migration", "POST", {
        operation: "preview",
        data: btoa(binary),
        password,
        recoveryKey,
      });
      previewId = data.previewId;
      reports(data, result);
      importButton.disabled = false;
      status.textContent = t(
        "미리보기를 확인한 뒤 가져오세요.",
        "Review the preview, then import.",
      );
    } finally {
      password = recoveryKey = "";
      passwordField.value = recoveryField.value = "";
    }
  });
  const importButton = action(
    inputSection,
    "확인 후 가져오기",
    "Confirm import",
    async () => {
      if (!previewId) return;
      const data = await api("/api/admin/migration", "POST", {
        operation: "import",
        previewId,
        confirmed: true,
      });
      previewId = undefined;
      importButton.disabled = true;
      reports(data, result);
      await restored(data.config);
      status.textContent = t("가져오기 완료", "Import complete");
    },
    "primary",
  );
  importButton.disabled = true;
  inputSection.append(result, status);

  const output = section("내보내기", "Export"),
    config = getConfig();
  let profileId = config.defaultProfileId,
    pageId = config.profiles.find((p) => p.id === profileId)?.defaultPageId,
    kind = "Profile",
    exportPassword = "";
  row(
    output,
    "프로필",
    "Profile",
    profileId,
    (value) => {
      profileId = value;
      pageId = config.profiles.find((p) => p.id === value)?.defaultPageId;
      updatePages();
    },
    { choices: Object.fromEntries(config.profiles.map((p) => [p.id, p.name])) },
  );
  row(
    output,
    "범위",
    "Scope",
    kind,
    (value) => {
      kind = value;
      pageInput.disabled = value === "Profile";
      updateWidgets();
    },
    {
      choices: {
        Profile: ["프로필", "Profile"],
        Folder: ["페이지", "Page"],
        Widgets: ["버튼", "Widgets"],
      },
    },
  );
  const pageInput = row(
    output,
    "페이지",
    "Page",
    pageId,
    (value) => {
      pageId = value;
      updateWidgets();
    },
    { choices: {} },
  );
  const widgets = el("div");
  output.append(widgets);
  const selectedIds = new Set();
  function updateWidgets() {
    widgets.replaceChildren();
    selectedIds.clear();
    if (kind !== "Widgets") return;
    for (const w of config.pages.find((p) => p.id === pageId)?.widgets || []) {
      selectedIds.add(w.id);
      row(
        widgets,
        w.label,
        w.label,
        true,
        (checked) =>
          checked ? selectedIds.add(w.id) : selectedIds.delete(w.id),
        { type: "checkbox" },
      );
    }
  }
  function updatePages() {
    pageInput.replaceChildren();
    for (const p of config.pages.filter((p) =>
      config.profiles.find((p) => p.id === profileId)?.pageIds.includes(p.id),
    )) {
      const option = el("option", p.name);
      option.value = p.id;
      pageInput.append(option);
    }
    pageInput.value = pageId;
    pageInput.disabled = kind === "Profile";
    updateWidgets();
  }
  updatePages();
  const exportPasswordInput = row(
    output,
    "암호 (선택)",
    "Password (optional)",
    "",
    (value) => (exportPassword = value),
    { type: "password" },
  );
  const exportReport = el("div");
  action(output, "파일 저장", "Save file", async () => {
    if (kind === "Widgets" && !selectedIds.size)
      throw Error(t("버튼을 선택하세요.", "Select a widget."));
    try {
      const data = await api("/api/admin/migration", "POST", {
        operation: "export",
        kind,
        profileId,
        pageId,
        widgetIds: [...selectedIds],
        password: exportPassword || undefined,
      });
      reports(data, exportReport);
      downloadFile(
        data.filename,
        Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)),
      );
    } finally {
      exportPassword = "";
      exportPasswordInput.value = "";
    }
  });
  output.append(exportReport);
}
