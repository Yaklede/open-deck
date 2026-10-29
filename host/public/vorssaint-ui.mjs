import { t, locale } from "./i18n.mjs";
const node = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
export async function showVorssaintSettings(api, widgetId) {
  const data = await api(
    "/api/extensions/vorssaint/settings?widgetId=" +
      encodeURIComponent(widgetId),
  );
  const lang = locale() === "ko" ? "ko" : "en",
    copy = data.copy[lang],
    label = (x) => x?.[lang] || x?.en || "";
  const dialog = node("dialog", undefined, "utility-dialog");
  const title = node("h2", label(data.group.label));
  dialog.append(
    title,
    node("p", "Vorssaint " + data.app.version),
    node("p", copy.description),
    node("p", copy.permission, "utility-muted"),
  );
  const form = node("form"),
    patch = {},
    status = node("p", undefined, "utility-status");
  for (const feature of data.features) {
    const section = node("details", undefined, "utility-feature");
    section.append(node("summary", label(feature.label)));
    if (feature.id === "general") section.open = true;
    for (const f of feature.fields) {
      const row = node("label", undefined, "utility-field");
      row.append(node("span", label(f.label)));
      let input;
      if (f.kind === "boolean") {
        input = node("input");
        input.type = "checkbox";
        input.checked = data.values[f.key] === true;
        input.onchange = () => {
          patch[f.key] = input.checked;
        };
      } else if (f.choices) {
        input = node("select");
        for (const v of f.choices) {
          const o = node(
            "option",
            label(f.choiceLabels?.[String(v)]) ||
              String(v) + (f.unit ? " " + f.unit : ""),
          );
          o.value = String(v);
          input.append(o);
        }
        input.value = String(data.values[f.key]);
        input.onchange = () => {
          patch[f.key] =
            f.kind === "integer" ? Number(input.value) : input.value;
        };
      } else {
        input = node("input");
        input.type = "number";
        input.min = f.min;
        input.max = f.max;
        input.step = 1;
        input.value = data.values[f.key];
        input.oninput = () => {
          patch[f.key] = Number(input.value);
        };
      }
      input.setAttribute(
        "aria-label",
        label(feature.label) + " · " + label(f.label),
      );
      row.append(input);
      section.append(row);
    }
    form.append(section);
  }
  const footer = node("div", undefined, "utility-footer"),
    cancel = node("button", t("닫기")),
    apply = node("button", copy.apply);
  cancel.type = "button";
  apply.type = "submit";
  cancel.onclick = () => dialog.close();
  footer.append(cancel, apply);
  form.append(status, footer);
  dialog.append(form);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!Object.keys(patch).length) {
      dialog.close();
      return;
    }
    apply.disabled = true;
    cancel.disabled = true;
    status.textContent = copy.applying;
    try {
      const result = await api("/api/extensions/vorssaint/settings", "POST", {
        widgetId,
        revision: data.revision,
        patch,
      });
      status.textContent = result.launchError
        ? copy.savedNotStarted
        : copy.saved;
      apply.hidden = true;
      cancel.disabled = false;
    } catch (e) {
      status.textContent = e.message?.includes("CONFLICT")
        ? copy.conflict
        : copy.unavailable;
      apply.disabled = false;
      cancel.disabled = false;
    }
  };
  dialog.addEventListener("cancel", (event) => {
    if (apply.disabled && cancel.disabled) event.preventDefault();
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
