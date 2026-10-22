// Profiles group existing pages; the initial migration retains every page and widget identity.
export function normalizeProfiles(config) {
  const ids = new Set(config.pages.map((p) => p.id));
  if (!config.profiles)
    config.profiles = [
      {
        id: "default",
        name: config.name || "기본 프로필",
        pageIds: [...ids],
        defaultPageId: config.pages[0]?.id || "",
        focusApps: [],
      },
    ];
  if (
    !Array.isArray(config.profiles) ||
    !config.profiles.length ||
    config.profiles.length > 40
  )
    throw Error("프로필은 1~40개입니다.");
  const seen = new Set(),
    assigned = new Set();
  for (const p of config.profiles) {
    if (
      !p ||
      typeof p.id !== "string" ||
      !p.id ||
      p.id.length > 80 ||
      seen.has(p.id) ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 80 ||
      !Array.isArray(p.pageIds)
    )
      throw Error("프로필 정보를 확인하세요.");
    seen.add(p.id);
    p.pageIds = p.pageIds.filter((id) => ids.has(id));
    for (const id of p.pageIds) {
      if (assigned.has(id))
        throw Error("페이지가 여러 프로필에 중복되어 있습니다.");
      assigned.add(id);
    }
    if (!p.pageIds.includes(p.defaultPageId))
      p.defaultPageId = p.pageIds[0] || "";
    p.focusApps ??= [];
    if (
      !Array.isArray(p.focusApps) ||
      p.focusApps.length > 32 ||
      p.focusApps.some(
        (a) =>
          typeof a !== "string" ||
          !/^([A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+$/.test(a),
      )
    )
      throw Error("앱 연결에는 bundle ID가 필요합니다.");
  }
  if (!seen.has(config.defaultProfileId))
    config.defaultProfileId = config.profiles[0].id;
  const target = config.profiles.find((p) => p.id === config.defaultProfileId);
  for (const id of ids) if (!assigned.has(id)) target.pageIds.push(id);
  if (!target.defaultPageId) target.defaultPageId = target.pageIds[0] || "";
  return config;
}
export function profileFor(config, device) {
  return (
    config.profiles.find(
      (p) => p.id === (device?.settings?.profileId || config.defaultProfileId),
    ) || config.profiles[0]
  );
}
export function pagesFor(config, device) {
  return device
    ? config.pages.filter((p) =>
        profileFor(config, device).pageIds.includes(p.id),
      )
    : config.pages;
}

export const profileDesignKeys = [
  "gap",
  "radius",
  "theme",
  "background",
  "gradient",
  "shadow",
  "showEmptyCells",
];
export function effectivePages(config, device = null) {
  const sourcePages = pagesFor(config, device);
  return sourcePages.map((source) => {
    const profile = config.profiles.find((p) => p.pageIds.includes(source.id));
    const result = structuredClone(source);
    if (source.inheritProfileDesign && profile?.defaults)
      for (const key of profileDesignKeys)
        if (profile.defaults[key] !== undefined)
          result[key] = profile.defaults[key];
    const inherited = [];
    for (const p of config.pages) {
      if (p.id === source.id) continue;
      for (const w of p.widgets) {
        if (
          w.pinScope === "global" ||
          (w.pinScope === "profile" && profile?.pageIds.includes(p.id))
        )
          inherited.push({
            ...structuredClone(w),
            inheritedPin: true,
            sourcePageId: p.id,
          });
      }
    }
    if (!inherited.length) return result;
    // Keep one source widget identity. Repack colliding page widgets after reserved pins.
    const pinned = result.widgets.filter((w) =>
      ["global", "profile"].includes(w.pinScope),
    );
    const regular = result.widgets.filter(
      (w) => !["global", "profile"].includes(w.pinScope),
    );
    const placed = [];
    const overlap = (a, b) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const w of [...pinned, ...inherited, ...regular]) {
      w.w = Math.min(w.w, result.columns);
      const fits = () =>
        w.x + w.w <= result.columns &&
        w.y + w.h <= 64 &&
        !placed.some((p) => overlap(w, p));
      if (!fits()) {
        let found = false;
        for (let y = 0; y <= 64 - w.h && !found; y++)
          for (let x = 0; x <= result.columns - w.w; x++) {
            w.x = x;
            w.y = y;
            if (fits()) {
              found = true;
              break;
            }
          }
        if (!found)
          throw Error(
            "고정 위젯을 배치할 공간이 없습니다. 페이지를 나누거나 고정을 줄이세요.",
          );
      }
      placed.push(w);
    }
    result.widgets = placed;
    result.rows = Math.max(result.rows, ...placed.map((w) => w.y + w.h));
    return result;
  });
}
