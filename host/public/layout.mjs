import { normalizeProfiles } from "./profiles.mjs";
export const themes = {
  midnight: {
    background: "#0c1320",
    surface: "#172436",
    text: "#e0e9fa",
    accent: "#a6acff",
  },
  graphite: {
    background: "#141517",
    surface: "#232528",
    text: "#eef0f2",
    accent: "#b8c6da",
  },
  ocean: {
    background: "#091c28",
    surface: "#123344",
    text: "#d9f4fa",
    accent: "#68c8d8",
  },
  paper: {
    background: "#e9edf2",
    surface: "#ffffff",
    text: "#233348",
    accent: "#4b6dba",
  },
};
export function geometry(page, portrait = false) {
  return portrait && page.portrait
    ? { columns: page.portrait.columns, rows: page.portrait.rows }
    : { columns: page.columns, rows: page.rows };
}
export function overlaps(a, b) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}
export function place(widgets, columns, minRows = 1, preserve = true) {
  const placed = [];
  for (const widget of widgets) {
    const w = Math.min(columns, Math.max(1, Number(widget.w) || 1)),
      h = Math.max(1, Number(widget.h) || 1);
    let box = {
      x: Math.max(0, Number(widget.x) || 0),
      y: Math.max(0, Number(widget.y) || 0),
      w,
      h,
    };
    const fits = (b) =>
      b.x + b.w <= columns && !placed.some((p) => overlaps(p, b));
    if (!preserve || !fits(box)) {
      let found = false;
      for (let y = 0; y < 256 && !found; y++)
        for (let x = 0; x <= columns - w; x++) {
          const candidate = { x, y, w, h };
          if (fits(candidate)) {
            box = candidate;
            found = true;
            break;
          }
        }
      if (!found) throw Error("페이지에 위젯을 더 배치할 수 없습니다.");
    }
    Object.assign(widget, box);
    placed.push(box);
  }
  return Math.max(minRows, ...placed.map((p) => p.y + p.h));
}
export function migrate(input) {
  const c = structuredClone(input);
  if (c.version !== 1 && c.version !== 2)
    throw Error("지원하지 않는 설정 버전입니다.");
  const legacy = c.version === 1;
  c.version = 2;
  c.variables ??= {};
  c.integrations ??= [];
  for (const p of c.pages || []) {
    p.columns ??= c.columns || 4;
    p.rows ??= Math.max(1, Math.ceil(p.widgets.length / p.columns));
    p.gap ??= 12;
    p.radius ??= 13;
    p.theme ??= "midnight";
    if (legacy) p.rows = place(p.widgets, p.columns, p.rows, false);
    for (const w of p.widgets || []) {
      w.w ??= 1;
      w.h ??= 1;
      w.style ??= {};
    }
  }
  return normalizeProfiles(c);
}
