import { randomUUID } from "node:crypto";
import {
  importMacroDeck,
  exportMacroDeck,
  mergeMacroDeckImport,
} from "./macrodeck-portable.mjs";
import { readAsset, saveAsset } from "./assets.mjs";

export class Migration {
  constructor({ dir, getConfig, applyConfig, backups, now = Date.now }) {
    Object.assign(this, { dir, getConfig, applyConfig, backups, now });
    this.previews = new Map();
  }
  async run(input) {
    for (const [id, value] of this.previews)
      if (value.expiresAt < this.now()) this.previews.delete(id);
    if (input.operation === "preview") {
      if (
        typeof input.data !== "string" ||
        input.data.length > 90_000_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)
      )
        throw Error("Select an archive up to 64 MiB.");
      const bytes = Buffer.from(input.data, "base64");
      if (
        bytes.length > 64 * 1024 * 1024 ||
        bytes.toString("base64") !== input.data
      )
        throw Error("Select an archive up to 64 MiB.");
      const result = await importMacroDeck(bytes, {
        password: input.password,
        recoveryKey: input.recoveryKey,
      });
      const id = randomUUID(),
        expiresAt = this.now() + 10 * 60_000;
      // Retain converted data briefly, never archive passwords or recovery keys.
      this.previews.clear();
      this.previews.set(id, { result, expiresAt });
      return {
        previewId: id,
        expiresAt,
        source: result.source,
        summary: result.summary,
        report: result.report,
      };
    }
    if (input.operation === "import") {
      const preview = this.previews.get(input.previewId);
      if (!preview || input.confirmed !== true)
        throw Error("Preview and confirm the archive before importing.");
      const merged = mergeMacroDeckImport(this.getConfig(), preview.result);
      // A locked encrypted vault aborts here, before any live data is touched.
      const safetyBackup = this.backups.create("before-migration");
      for (const [id, data] of Object.entries(merged.assets)) {
        const saved = saveAsset(this.dir, data);
        if (saved.id !== id)
          throw Error("Imported image integrity check failed.");
      }
      this.applyConfig(merged.config);
      this.previews.delete(input.previewId);
      return { config: this.getConfig(), report: merged.report, safetyBackup };
    }
    if (input.operation === "export") {
      const config = this.getConfig(),
        assets = {};
      for (const id of new Set(
        config.pages
          .flatMap((p) => p.widgets.map((w) => w.image))
          .filter(Boolean),
      )) {
        try {
          const asset = readAsset(this.dir, id);
          assets[id] =
            `data:${asset.mime};base64,${asset.bytes.toString("base64")}`;
        } catch {}
      }
      const result = await exportMacroDeck(config, {
        kind: input.kind,
        profileId: input.profileId,
        pageId: input.pageId,
        widgetIds: input.widgetIds,
        password: input.password,
        assets,
      });
      return {
        filename: result.filename,
        data: result.bytes.toString("base64"),
        report: result.report,
      };
    }
    throw Error("Choose an import or export operation.");
  }
}
