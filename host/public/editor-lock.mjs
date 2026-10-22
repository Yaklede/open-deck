let unlockPending,
  monitor,
  configured = false,
  lastActivitySent = 0;
const text = (ko, en) => (document.documentElement.lang === "en" ? en : ko);
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
      result.error ||
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
export function showEditorLock() {
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
    form.onsubmit = async (event) => {
      event.preventDefault();
      button.disabled = true;
      status.textContent = "";
      const entered = password.value;
      password.value = "";
      try {
        await request("unlock", { password: entered });
        dialog.close();
        dialog.remove();
        unlockPending = undefined;
        lastActivitySent = Date.now();
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
    password.focus();
  });
  return unlockPending;
}
export async function ensureEditorUnlocked() {
  const status = await editorLockStatus();
  if (status.locked) await showEditorLock();
}
export function startEditorLockMonitor() {
  if (monitor) return;
  monitor = setInterval(async () => {
    try {
      const status = await editorLockStatus();
      if (status.locked) showEditorLock();
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
