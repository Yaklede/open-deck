import { t as translate } from "./i18n.mjs";
let unlockPending,
  loginPending,
  loginChecking,
  finishEditorUnlock,
  monitor,
  configured = false,
  lastActivitySent = 0;
const text = (ko, en) => translate(ko, en);
const element = (tag, content, className) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
};
async function request(operation, values = {}) {
  const response = await fetch("/api/admin/lock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, ...values }),
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      translate(result.error) ||
        text("잠금 해제에 실패했습니다.", "Could not unlock the editor."),
    );
  return result;
}
export async function editorLockStatus() {
  const response = await fetch("/api/admin/lock-status", { cache: "no-store" });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      result.error ||
        text("잠금 상태를 확인할 수 없습니다.", "Could not check lock status."),
    );
  configured = result.configured;
  return result;
}
async function accountStatus() {
  const response = await fetch("/api/admin/account", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw Error(translate(data.error));
  return data;
}
export function showAccountLogin() {
  if (loginPending) return loginPending;
  if (loginChecking) return loginChecking;
  // A delayed 401 from before sign-in must not open a second login dialog.
  loginChecking = accountStatus()
    .then(
      (state) => {
        if (state.configured && !state.authenticated) return openAccountLogin();
      },
      () => openAccountLogin(),
    )
    .finally(() => {
      loginChecking = undefined;
    });
  return loginChecking;
}
function openAccountLogin() {
  if (loginPending) return loginPending;
  loginPending = new Promise((resolve) => {
    const dialog = element("dialog", undefined, "editor-lock");
    dialog.setAttribute(
      "aria-label",
      text("Open Deck 관리자 로그인", "Open Deck administrator login"),
    );
    const title = element("h2", text("관리자 로그인", "Administrator login"));
    dialog.append(
      element("div", "◈", "lock-symbol"),
      title,
      element(
        "p",
        text(
          "연결된 태블릿은 계속 사용할 수 있습니다.",
          "Connected tablets remain available.",
        ),
      ),
    );
    const form = element("form"),
      name = element("input"),
      password = element("input"),
      confirmation = element("input"),
      key = element("input"),
      button = element("button", text("로그인", "Sign in"), "primary"),
      toggle = element(
        "button",
        text("복구 키로 계정 복구", "Recover account with recovery key"),
      ),
      status = element("p", "", "lock-status");
    name.type = "text";
    name.autocomplete = "username";
    name.required = true;
    name.placeholder = text("사용자명", "Username");
    name.setAttribute("aria-label", text("사용자명", "Username"));
    password.type = "password";
    password.autocomplete = "current-password";
    password.required = true;
    password.placeholder = text("계정 암호", "Account password");
    password.setAttribute("aria-label", password.placeholder);
    key.type = "password";
    key.autocomplete = "off";
    key.placeholder = text("계정 복구 키", "Account recovery key");
    key.setAttribute("aria-label", key.placeholder);
    key.hidden = true;
    confirmation.type = "password";
    confirmation.autocomplete = "new-password";
    confirmation.placeholder = text(
      "새 암호 다시 입력",
      "Confirm new password",
    );
    confirmation.setAttribute("aria-label", confirmation.placeholder);
    confirmation.hidden = true;
    let recovering = false;
    toggle.type = "button";
    toggle.onclick = () => {
      recovering = !recovering;
      key.hidden = !recovering;
      key.required = recovering;
      confirmation.hidden = !recovering;
      confirmation.required = recovering;
      password.autocomplete = recovering ? "new-password" : "current-password";
      password.placeholder = recovering
        ? text(
            "새 계정 암호 (8자 이상)",
            "New account password (8+ characters)",
          )
        : text("계정 암호", "Account password");
      password.setAttribute("aria-label", password.placeholder);
      title.textContent = recovering
        ? text("계정 복구", "Recover account")
        : text("관리자 로그인", "Administrator login");
      button.textContent = recovering
        ? text("암호 재설정 후 로그인", "Reset password and sign in")
        : text("로그인", "Sign in");
      toggle.textContent = recovering
        ? text("로그인으로 돌아가기", "Back to sign in")
        : text("복구 키로 계정 복구", "Recover account with recovery key");
      status.textContent = recovering
        ? text(
            "복구에 사용한 키와 기존 로그인 세션은 폐기됩니다.",
            "Recovery consumes this key and revokes existing login sessions.",
          )
        : "";
    };
    button.type = "submit";
    status.setAttribute("role", "status");
    form.append(name, key, password, confirmation, button, toggle, status);
    dialog.append(form);
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    dialog.addEventListener("keydown", (event) => event.stopPropagation());
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (recovering && password.value !== confirmation.value) {
        status.textContent = text(
          "암호가 일치하지 않습니다.",
          "Passwords do not match.",
        );
        return;
      }
      const values = {
        operation: recovering ? "recover" : "login",
        username: name.value,
        password: password.value,
        name: "Open Deck editor",
        ...(recovering ? { recoveryKey: key.value } : {}),
      };
      password.value = "";
      confirmation.value = "";
      key.value = "";
      button.disabled = true;
      try {
        const response = await fetch("/api/admin/account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        const result = await response.json();
        if (!response.ok) throw Error(translate(result.error));
        dialog.close();
        dialog.remove();
        loginPending = undefined;
        finishEditorUnlock?.();
        window.dispatchEvent(new Event("opendeck:unlocked"));
        resolve();
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
        password.focus();
      }
    };
    document.body.append(dialog);
    dialog.showModal();
    name.focus();
  });
  return loginPending;
}
export function showEditorLock() {
  if (loginPending) return loginPending;
  if (unlockPending) return unlockPending;
  unlockPending = new Promise((resolve) => {
    const dialog = element("dialog", undefined, "editor-lock");
    dialog.setAttribute(
      "aria-label",
      text("Open Deck 편집기 잠금", "Open Deck editor locked"),
    );
    dialog.append(
      element("div", "◈", "lock-symbol"),
      element("h2", text("편집기가 잠겨 있어요", "Editor locked")),
      element(
        "p",
        text(
          "계속하려면 편집기 암호를 입력하세요. 연결된 태블릿은 계속 사용할 수 있어요.",
          "Enter your editor password to continue. Connected tablets remain available.",
        ),
      ),
    );
    const form = element("form"),
      password = element("input"),
      button = element("button", text("잠금 해제", "Unlock"), "primary"),
      status = element("p", "", "lock-status");
    password.type = "password";
    password.autocomplete = "current-password";
    password.required = true;
    password.setAttribute("aria-label", text("편집기 암호", "Editor password"));
    button.type = "submit";
    status.setAttribute("role", "status");
    form.append(password, button, status);
    dialog.append(form);
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    dialog.addEventListener("keydown", (event) => event.stopPropagation());
    finishEditorUnlock = () => {
      dialog.close();
      dialog.remove();
      unlockPending = undefined;
      finishEditorUnlock = undefined;
      lastActivitySent = Date.now();
      window.dispatchEvent(new Event("opendeck:unlocked"));
      resolve();
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      button.disabled = true;
      status.textContent = "";
      const entered = password.value;
      password.value = "";
      try {
        await request("unlock", { password: entered });
        finishEditorUnlock?.();
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
        password.focus();
      }
    };
    document.body.append(dialog);
    dialog.showModal();
    password.focus();
  });
  return unlockPending;
}
export async function ensureEditorUnlocked() {
  const account = await accountStatus();
  if (account.configured && !account.authenticated) await showAccountLogin();
  const status = await editorLockStatus();
  if (status.locked) await showEditorLock();
}
export function startEditorLockMonitor() {
  if (monitor) return;
  monitor = setInterval(async () => {
    try {
      await ensureEditorUnlocked();
    } catch {
      /* A reconnect must not clear an existing lock screen. */
    }
  }, 15000);
  const activity = () => {
    if (!configured || unlockPending || Date.now() - lastActivitySent < 30000)
      return;
    lastActivitySent = Date.now();
    request("activity").catch(() => {
      ensureEditorUnlocked().catch(() => {});
    });
  };
  document.addEventListener("pointerdown", activity, { passive: true });
  document.addEventListener("keydown", activity, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) ensureEditorUnlocked().catch(() => {});
  });
}
