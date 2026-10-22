import { showAccountLogin } from "./editor-lock.mjs";
import { locale } from "./i18n.mjs";
import { downloadFile } from "./downloads.mjs";
const when = (value) =>
  new Date(value).toLocaleString(locale(), {
    hour12: document.body.dataset.timeFormat === "12h",
  });
function recoveryStateNote(ctx, parent, state) {
  const messages = {
    pending: [
      "새 복구 키의 보관 확인을 기다리고 있습니다.",
      "Waiting for confirmation that the new recovery key was stored.",
    ],
    lost: [
      "복구 키가 분실 처리되었습니다. 새 키를 만들어야 복구 기능을 사용할 수 있습니다.",
      "The recovery key was marked lost. Create a new key to enable recovery.",
    ],
    consumed: [
      "복구에 사용한 키가 폐기되었습니다. 새 키를 생성하세요.",
      "The recovery key was consumed. Create a new key.",
    ],
  };
  if (messages[state]) ctx.note(parent, ...messages[state]);
}

export async function revealRecoveryKey(
  { el, t, action, api, passwordInput },
  endpoint,
  prepared,
) {
  const dialog = el("dialog", undefined, "profile-dialog");
  dialog.append(
    el(
      "h3",
      t("복구 키를 안전하게 보관하세요", "Store your recovery key safely"),
    ),
  );
  dialog.append(
    el(
      "p",
      t(
        "이 키는 지금 한 번만 표시됩니다. 암호와 다른 안전한 위치에 보관하세요. 보관 확인 전에는 기존 키가 유지됩니다.",
        "This key is displayed once. Store it somewhere safe, separate from your password. Your previous key remains active until confirmation.",
      ),
    ),
  );
  const key = el("textarea");
  key.value = prepared.recoveryKey;
  key.readOnly = true;
  key.rows = 3;
  key.setAttribute("aria-label", t("복구 키", "Recovery key"));
  dialog.append(key);
  action(dialog, "키 파일 저장", "Save key file", () =>
    downloadFile(
      endpoint.includes("account")
        ? "open-deck-account-recovery-key.txt"
        : "open-deck-backup-recovery-key.txt",
      `${endpoint.includes("account") ? "Open Deck account recovery key" : "Open Deck encrypted backup recovery key"}\n${prepared.recoveryKey}\n`,
      "text/plain",
    ),
  );
  const label = el("label", undefined, "settings-row"),
    check = el("input");
  check.type = "checkbox";
  label.append(
    el(
      "span",
      t(
        "복구 키를 별도로 보관했습니다",
        "I stored this recovery key separately",
      ),
    ),
    check,
  );
  dialog.append(label);
  const status = el("p", "", "settings-status");
  dialog.append(status);
  return new Promise((resolve) => {
    let confirmed = false;
    const button = action(
      dialog,
      "보관 확인 · 키 활성화",
      "Confirm storage and activate",
      async () => {
        if (!check.checked) return;
        const reentered = await passwordInput(
          t(
            "보관한 복구 키를 다시 입력하세요",
            "Re-enter the recovery key you stored",
          ),
        );
        if (reentered === null) return;
        try {
          await api(endpoint, "POST", {
            operation: "recovery-confirm",
            confirmationId: prepared.confirmationId,
            recoveryKey: reentered,
          });
          confirmed = true;
          dialog.close();
        } catch (error) {
          status.textContent = error.message;
        }
      },
      "primary",
    );
    button.disabled = true;
    check.onchange = () => (button.disabled = !check.checked);
    action(dialog, "나중에 설정", "Set up later", () => dialog.close());
    dialog.addEventListener("close", () => {
      key.value = "";
      prepared.recoveryKey = "";
      dialog.remove();
      resolve(confirmed);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export async function renderAccountSecurity(ctx) {
  const {
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
    isCurrent,
  } = ctx;
  const account = await api("/api/admin/account");
  if (!isCurrent()) return;
  const s = section("관리자 계정", "Administrator account");
  note(
    s,
    "로그인 세션은 이 맥의 편집기와 설정 변경을 보호합니다. 연결된 태블릿은 계속 사용할 수 있습니다.",
    "Login sessions protect this Mac’s editor and settings. Connected tablets remain available.",
  );
  if (!account.configured) {
    note(
      s,
      "계정을 만들면 사용자명과 암호로 편집기에 로그인합니다.",
      "Create an account to sign into the editor with a username and password.",
    );
    action(
      s,
      "관리자 계정 만들기",
      "Create administrator account",
      async () => {
        const username = prompt(t("사용자명", "Username"));
        if (username === null) return;
        const password = await passwordInput(
          t("계정 암호 (8자 이상)", "Account password (8+ characters)"),
        );
        if (password === null) return;
        const confirmation = await passwordInput(
          t("계정 암호 다시 입력", "Confirm account password"),
        );
        if (confirmation === null) return;
        if (password !== confirmation)
          throw Error(
            t("암호가 일치하지 않습니다.", "Passwords do not match."),
          );
        await api("/api/admin/account", "POST", {
          operation: "setup",
          username,
          password,
          sessionHours: 24,
          name: "Open Deck editor",
        });
        await reload();
      },
      "primary",
    );
    return;
  }
  note(
    s,
    `현재 사용자: ${account.username}`,
    `Signed in as ${account.username}`,
  );
  let username = account.username,
    hours = account.sessionHours;
  row(s, "사용자명", "Username", username, (v) => (username = v));
  row(
    s,
    "로그인 유지 (시간)",
    "Session lifetime (hours)",
    hours,
    (v) => (hours = v),
    { type: "number", min: 1, max: 720 },
  );
  action(s, "계정 정보 저장", "Save account details", async () => {
    const currentPassword = await passwordInput(
      t("현재 계정 암호", "Current account password"),
    );
    if (currentPassword === null) return;
    await api("/api/admin/account", "POST", {
      operation: "update",
      username,
      sessionHours: hours,
      currentPassword,
    });
    await reload();
  });
  action(s, "계정 암호 변경", "Change account password", async () => {
    const currentPassword = await passwordInput(
      t("현재 계정 암호", "Current account password"),
    );
    if (currentPassword === null) return;
    const password = await passwordInput(
      t("새 계정 암호 (8자 이상)", "New account password (8+ characters)"),
    );
    if (password === null) return;
    const confirmation = await passwordInput(
      t("새 암호 다시 입력", "Confirm new password"),
    );
    if (confirmation === null) return;
    if (password !== confirmation)
      throw Error(t("암호가 일치하지 않습니다.", "Passwords do not match."));
    await api("/api/admin/account", "POST", {
      operation: "update",
      currentPassword,
      password,
    });
    await reload();
  });
  const recovery = section("계정 복구 키", "Account recovery key");
  recoveryStateNote(ctx, recovery, account.recoveryState);
  note(
    recovery,
    account.recoveryConfigured
      ? "계정 복구 키가 활성화되어 있습니다. 분실했다면 새 키로 교체하세요."
      : "계정 복구 키가 없습니다. 암호를 잊기 전에 생성하고 보관하세요.",
    account.recoveryConfigured
      ? "An account recovery key is active. Replace it if you have lost it."
      : "No account recovery key is active. Create and store one before you forget your password.",
  );
  note(
    recovery,
    "계정 복구에 한 번 사용한 키는 폐기됩니다. 암호화 백업 복구 키는 별도로 관리합니다.",
    "Account recovery keys are consumed after use. Encrypted backup recovery keys are managed separately.",
  );
  action(
    recovery,
    account.recoveryConfigured ? "계정 복구 키 교체" : "계정 복구 키 생성",
    account.recoveryConfigured
      ? "Replace account recovery key"
      : "Create account recovery key",
    async () => {
      const password = await passwordInput(
        t("현재 계정 암호", "Current account password"),
      );
      if (password === null) return;
      const prepared = await api("/api/admin/account", "POST", {
        operation: "recovery-prepare",
        password,
      });
      await revealRecoveryKey(ctx, "/api/admin/account", prepared);
      await reload();
    },
  );
  if (account.recoveryConfigured)
    action(
      recovery,
      "계정 복구 키 분실 처리",
      "Mark account recovery key lost",
      async () => {
        if (
          !confirm(
            t(
              "현재 복구 키를 비활성화하고 분실 처리할까요? 새 키를 생성하기 전까지 계정 복구가 불가능합니다.",
              "Deactivate the current recovery key and mark it lost? Account recovery will be unavailable until a new key is created.",
            ),
          )
        )
          return;
        const password = await passwordInput(
          t("현재 계정 암호", "Current account password"),
        );
        if (password === null) return;
        await api("/api/admin/account", "POST", {
          operation: "recovery-lost",
          password,
        });
        await reload();
      },
      "danger",
    );
  const sessions = section("로그인 세션", "Login sessions");
  for (const session of account.sessions || []) {
    const r = el("div", undefined, "backup-row");
    r.append(
      el(
        "strong",
        `${session.name}${session.current ? ` · ${t("현재 세션", "Current session")}` : ""}`,
      ),
    );
    r.append(
      el(
        "small",
        `${t("최근 사용", "Last active")}: ${when(session.lastSeenAt)} · ${t("만료", "Expires")}: ${when(session.expiresAt)}`,
      ),
    );
    action(
      r,
      "세션 종료",
      "End session",
      async () => {
        await api("/api/admin/account", "POST", {
          operation: "revoke-session",
          id: session.id,
        });
        if (session.current) await showAccountLogin();
        await reload();
      },
      "danger",
    );
    sessions.append(r);
  }
  action(
    sessions,
    "모든 세션 로그아웃",
    "Sign out all sessions",
    async () => {
      if (
        !confirm(
          t(
            "현재 창을 포함한 모든 로그인 세션을 종료할까요?",
            "Sign out every session, including this window?",
          ),
        )
      )
        return;
      await api("/api/admin/account", "POST", { operation: "revoke-all" });
      await showAccountLogin();
      await reload();
    },
    "danger",
  );
}

export async function renderVaultSecurity(ctx, { backup = false } = {}) {
  const {
    api,
    section,
    note,
    action,
    t,
    passwordInput,
    reload,
    el,
    isCurrent,
  } = ctx;
  const vault = await api("/api/admin/vault");
  if (!isCurrent()) return;
  const s = section(
    backup ? "로컬 백업 암호화" : "암호화 비밀 저장소",
    backup ? "Local backup encryption" : "Encrypted secret vault",
  );
  note(
    s,
    "저장소는 별도의 암호로 보호됩니다. 앱을 다시 시작하면 잠기며, 잠긴 동안 암호화 예약 백업과 저장소 비밀을 쓰는 연결은 대기합니다.",
    "The vault has its own password. It locks after an app restart; encrypted scheduled backups and connections using vault secrets wait until it is unlocked.",
  );
  if (!vault.configured) {
    action(
      s,
      "비밀 저장소 만들기",
      "Create secret vault",
      async () => {
        const password = await passwordInput(
          t("저장소 암호 (8자 이상)", "Vault password (8+ characters)"),
        );
        if (password === null) return;
        const confirmPassword = await passwordInput(
          t("저장소 암호 다시 입력", "Confirm vault password"),
        );
        if (confirmPassword === null) return;
        if (password !== confirmPassword)
          throw Error(
            t("암호가 일치하지 않습니다.", "Passwords do not match."),
          );
        await api("/api/admin/vault", "POST", { operation: "setup", password });
        await reload();
      },
      "primary",
    );
    return;
  }
  note(
    s,
    vault.unlocked ? "저장소 잠금 해제됨" : "저장소 잠김",
    vault.unlocked ? "Vault unlocked" : "Vault locked",
  );
  if (!vault.unlocked) {
    action(
      s,
      "저장소 잠금 해제",
      "Unlock vault",
      async () => {
        const password = await passwordInput(
          t("저장소 암호", "Vault password"),
        );
        if (password === null) return;
        await api("/api/admin/vault", "POST", {
          operation: "unlock",
          password,
        });
        await reload();
      },
      "primary",
    );
    if (vault.recoveryConfigured)
      action(s, "저장소 암호 복구", "Recover vault password", async () => {
        const recoveryKey = await passwordInput(
          t("저장소 복구 키", "Vault recovery key"),
        );
        if (recoveryKey === null) return;
        const password = await passwordInput(
          t("새 저장소 암호 (8자 이상)", "New vault password (8+ characters)"),
        );
        if (password === null) return;
        const confirmation = await passwordInput(
          t("새 암호 다시 입력", "Confirm new password"),
        );
        if (confirmation === null) return;
        if (password !== confirmation)
          throw Error(
            t("암호가 일치하지 않습니다.", "Passwords do not match."),
          );
        await api("/api/admin/vault", "POST", {
          operation: "recover",
          recoveryKey,
          password,
        });
        await reload();
      });
    note(
      s,
      "암호와 복구 키를 모두 잃으면 암호화 데이터는 복구할 수 없습니다.",
      "Encrypted data cannot be recovered if both the password and recovery key are lost.",
    );
    return;
  }
  recoveryStateNote(ctx, s, vault.recoveryState);
  note(
    s,
    vault.recoveryConfigured
      ? "백업 복구 키가 활성화되어 있습니다."
      : "백업 복구 키가 없습니다. 로컬 백업 암호화를 켜기 전에 생성하세요.",
    vault.recoveryConfigured
      ? "A backup recovery key is active."
      : "No backup recovery key is active. Create one before enabling local backup encryption.",
  );
  action(
    s,
    vault.recoveryConfigured ? "백업 복구 키 교체" : "백업 복구 키 생성",
    vault.recoveryConfigured
      ? "Replace backup recovery key"
      : "Create backup recovery key",
    async () => {
      const prepared = await api("/api/admin/vault", "POST", {
        operation: "recovery-prepare",
      });
      await revealRecoveryKey(ctx, "/api/admin/vault", prepared);
      await reload();
    },
  );
  if (vault.recoveryConfigured)
    action(
      s,
      "백업 복구 키 분실 처리",
      "Mark backup recovery key lost",
      async () => {
        if (
          !confirm(
            t(
              "현재 백업 복구 키를 비활성화하고 분실 처리할까요? 저장소 암호는 계속 사용할 수 있습니다.",
              "Deactivate the backup recovery key and mark it lost? Your vault password will keep working.",
            ),
          )
        )
          return;
        await api("/api/admin/vault", "POST", { operation: "recovery-lost" });
        await reload();
      },
      "danger",
    );
  note(
    s,
    "키를 교체해도 이미 내보낸 백업에는 당시의 복구 키가 필요합니다. 새 키를 만든 뒤 중요한 백업을 다시 내보내세요.",
    "Previously exported backups still require the recovery key used at export. Export important backups again after replacing the key.",
  );
  action(
    s,
    vault.localBackupsEncrypted
      ? "새 로컬 백업 암호화 끄기"
      : "로컬 백업 암호화 켜기",
    vault.localBackupsEncrypted
      ? "Disable encryption for new local backups"
      : "Encrypt local backups",
    async () => {
      await api("/api/admin/vault", "POST", {
        operation: "encryption",
        enabled: !vault.localBackupsEncrypted,
      });
      await reload();
    },
  );
  note(
    s,
    vault.localBackupsEncrypted
      ? "새 백업은 AES-256-GCM으로 암호화됩니다. 기존 평문 백업은 아래 버튼으로 변환하세요."
      : "새 로컬 백업은 암호화되지 않습니다. 기존 암호화 백업은 그대로 유지됩니다.",
    vault.localBackupsEncrypted
      ? "New backups use AES-256-GCM encryption. Convert older plaintext backups below."
      : "New local backups are not encrypted. Existing encrypted backups stay encrypted.",
  );
  if (vault.localBackupsEncrypted)
    action(
      s,
      "기존 로컬 백업 모두 암호화",
      "Encrypt existing local backups",
      async () => {
        await api("/api/admin/backups", "POST", {
          operation: "encrypt-existing",
        });
        await reload();
      },
    );
  if (!backup) {
    action(s, "저장소 암호 변경", "Change vault password", async () => {
      const currentPassword = await passwordInput(
        t("현재 저장소 암호", "Current vault password"),
      );
      if (currentPassword === null) return;
      const password = await passwordInput(
        t("새 저장소 암호 (8자 이상)", "New vault password (8+ characters)"),
      );
      if (password === null) return;
      const confirmation = await passwordInput(
        t("새 암호 다시 입력", "Confirm new password"),
      );
      if (confirmation === null) return;
      if (password !== confirmation)
        throw Error(t("암호가 일치하지 않습니다.", "Passwords do not match."));
      await api("/api/admin/vault", "POST", {
        operation: "password",
        currentPassword,
        password,
      });
      await reload();
    });
    const secrets = section("저장된 연결 비밀", "Stored connection secrets");
    note(
      secrets,
      "비밀 식별자를 HTTP 연결의 secretId와 동일하게 지정하세요. 저장된 값은 화면이나 내보내기에서 공개되지 않습니다.",
      "Use the same secret ID as the HTTP connection’s secretId. Saved values are never revealed in the UI or regular backups.",
    );
    for (const secret of vault.secrets || []) {
      const r = el("div", undefined, "backup-row");
      r.append(el("strong", `${secret.label || secret.id} · ${secret.id}`));
      action(r, "값 교체", "Replace value", async () => {
        const value = await passwordInput(t("새 비밀 값", "New secret value"));
        if (value === null) return;
        await api("/api/admin/vault", "POST", {
          operation: "secret-set",
          id: secret.id,
          label: secret.label,
          value,
        });
        await reload();
      });
      action(
        r,
        "비밀 삭제",
        "Delete secret",
        async () => {
          if (
            !confirm(
              t(
                "이 비밀을 삭제할까요? 연결에서 더 이상 사용할 수 없습니다.",
                "Delete this secret? Connections will no longer be able to use it.",
              ),
            )
          )
            return;
          await api("/api/admin/vault", "POST", {
            operation: "secret-delete",
            id: secret.id,
          });
          await reload();
        },
        "danger",
      );
      secrets.append(r);
    }
    action(secrets, "연결 비밀 추가", "Add connection secret", async () => {
      const id = prompt(
        t(
          "비밀 식별자 (영문·숫자·밑줄·하이픈)",
          "Secret ID (letters, numbers, underscores, hyphens)",
        ),
      );
      if (id === null) return;
      const label = prompt(t("비밀 이름", "Secret label"), id);
      if (label === null) return;
      const value = await passwordInput(t("비밀 값", "Secret value"));
      if (value === null) return;
      await api("/api/admin/vault", "POST", {
        operation: "secret-set",
        id,
        label,
        value,
      });
      await reload();
    });
  }
  action(s, "지금 저장소 잠그기", "Lock vault now", async () => {
    await api("/api/admin/vault", "POST", { operation: "lock" });
    await reload();
  });
}
