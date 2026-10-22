// Pure profile/archive operations shared by the editor and verification tests.
export function activeProfile(config, id) {
  return (
    config.profiles?.find((p) => p.id === id) ||
    config.profiles?.find((p) => p.id === config.defaultProfileId) ||
    config.profiles?.[0]
  );
}
export function profilePages(config, id) {
  const profile = activeProfile(config, id);
  return profile
    ? config.pages.filter((p) => profile.pageIds.includes(p.id))
    : config.pages;
}
export function clonePages(pages, uuid = () => crypto.randomUUID()) {
  const ids = new Map(pages.map((p) => [p.id, uuid()]));
  return structuredClone(pages).map((p) => {
    p.id = ids.get(p.id);
    p.parentId = ids.get(p.parentId) || undefined;
    for (const w of p.widgets) {
      w.id = uuid();
      if (w.targetPage) w.targetPage = ids.get(w.targetPage) || p.id;
    }
    return p;
  });
}
export function portableProfile(config, id) {
  const profile = activeProfile(config, id);
  const pages = structuredClone(profilePages(config, id));
  const widgets = new Set(pages.flatMap((p) => p.widgets.map((w) => w.id)));
  return {
    ...structuredClone(config),
    kind: "open-deck-profile",
    name: profile.name,
    pages,
    profiles: [structuredClone(profile)],
    defaultProfileId: profile.id,
    automations: (config.automations || []).filter((a) =>
      widgets.has(a.widgetId),
    ),
  };
}
export function importProfile(
  config,
  archive,
  uuid = () => crypto.randomUUID(),
) {
  const pages = clonePages(archive.pages || [], uuid);
  if (!pages.length) throw Error("프로필에는 페이지가 하나 이상 필요합니다.");
  if (config.pages.length + pages.length > 40)
    throw Error("페이지는 최대 40개입니다.");
  // Preserve executable steps but never overwrite existing variables/integrations.
  for (const [key, value] of Object.entries(archive.variables || {})) {
    if (
      Object.hasOwn(config.variables, key) &&
      typeof config.variables[key] !== typeof value
    )
      throw Error("변수 형식이 충돌합니다: " + key);
  }
  for (const integration of archive.integrations || []) {
    const current = config.integrations.find((i) => i.id === integration.id);
    if (current && JSON.stringify(current) !== JSON.stringify(integration))
      throw Error("연동 ID가 충돌합니다: " + integration.id);
  }
  const ids = new Map();
  (archive.pages || []).forEach((p, i) =>
    p.widgets.forEach((w, j) => ids.set(w.id, pages[i].widgets[j].id)),
  );
  const sourceProfile =
    archive.profiles?.find((p) => p.id === archive.defaultProfileId) ||
    archive.profiles?.[0];
  const defaultIndex = Math.max(
    0,
    (archive.pages || []).findIndex(
      (p) => p.id === sourceProfile?.defaultPageId,
    ),
  );
  const profile = {
    id: uuid(),
    name: String(archive.name || "가져온 프로필").slice(0, 80),
    pageIds: pages.map((p) => p.id),
    defaultPageId: pages[defaultIndex]?.id || pages[0].id,
    defaults: structuredClone(sourceProfile?.defaults || {}),
    focusApps: [],
  };
  config.pages.push(...pages);
  config.profiles.push(profile);
  for (const [key, value] of Object.entries(archive.variables || {}))
    if (!Object.hasOwn(config.variables, key)) config.variables[key] = value;
  for (const integration of archive.integrations || [])
    if (!config.integrations.some((i) => i.id === integration.id))
      config.integrations.push(structuredClone(integration));
  for (const automation of archive.automations || [])
    if (ids.has(automation.widgetId))
      config.automations.push({
        ...structuredClone(automation),
        id: uuid(),
        widgetId: ids.get(automation.widgetId),
        enabled: false,
      });
  return profile;
}
