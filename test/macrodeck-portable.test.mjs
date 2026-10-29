import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, createCipheriv, hkdfSync } from "node:crypto";
import { readZip, writeZip } from "../host/safe-zip.mjs";
import {
  importMacroDeck,
  exportMacroDeck,
  mergeMacroDeckImport,
} from "../host/macrodeck-portable.mjs";
import { defaultConfig, validateConfig } from "../host/config.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const fixture = () => ({
  kind: "Profile",
  profile: {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Example",
    defaultColumns: 4,
    defaultRows: 3,
    folders: [
      {
        id: "22222222-2222-2222-2222-222222222222",
        name: "Home",
        isDefault: true,
        widgets: [
          {
            id: "33333333-3333-3333-3333-333333333333",
            type: "ActionButton",
            positionX: 0,
            positionY: 0,
            width: 2,
            height: 1,
            data: JSON.stringify({
              label: "Open website",
              backgroundColor: "#113355",
              flows: [
                {
                  triggerId: "a",
                  triggerType: "onShortPress",
                  children: [
                    {
                      type: "action",
                      integrationId: "app.macro-deck.system",
                      actionId: "open-website",
                      parameters: [
                        { name: "url", value: "https://example.com" },
                      ],
                    },
                  ],
                },
                {
                  triggerId: "b",
                  triggerType: "onLongPress",
                  children: [
                    {
                      type: "delay",
                      parameters: [{ name: "duration", value: 300 }],
                    },
                  ],
                },
              ],
            }),
          },
        ],
      },
    ],
  },
  variables: [],
  icons: [],
  fonts: [],
  scripts: [],
  secrets: [],
});
function archive(content) {
  const bytes = Buffer.from(JSON.stringify(content));
  return writeZip({
    "content.json": bytes,
    "manifest.json": Buffer.from(
      JSON.stringify({
        formatVersion: 2,
        kind: content.kind,
        encryption: null,
        files: [
          {
            path: "content.json",
            size: bytes.length,
            sha256: "sha256:" + hash(bytes),
          },
        ],
      }),
    ),
  });
}
test("native profile keeps layout, appearance, URL and long-press action", async () => {
  const r = await importMacroDeck(archive(fixture()));
  assert.equal(r.config.pages[0].widgets[0].w, 2);
  assert.equal(r.config.pages[0].widgets[0].style.background, "#113355");
  assert.equal(
    r.config.pages[0].widgets[0].actions[0].value,
    "https://example.com",
  );
  assert.equal(r.config.pages[0].widgets[0].longActions[0].value, 300);
  assert.equal(r.report.length, 0);
});
test("unknown plugin actions are inert and explicitly reported", async () => {
  const f = fixture(),
    d = JSON.parse(f.profile.folders[0].widgets[0].data);
  d.flows[0].children[0].integrationId = "plugin.unknown";
  f.profile.folders[0].widgets[0].data = JSON.stringify(d);
  const r = await importMacroDeck(archive(f));
  assert.deepEqual(r.config.pages[0].widgets[0].actions, []);
  assert.ok(r.report.some((x) => x.code === "action-not-imported"));
});
test("native Profile, Folder and Widgets export/import with encryption roundtrip", async () => {
  const source = (await importMacroDeck(archive(fixture()))).config;
  for (const kind of ["Profile", "Folder", "Widgets"]) {
    for (const password of [undefined, "test-password-only"]) {
      const exported = await exportMacroDeck(source, { kind, password });
      assert.match(exported.filename, /\.macroDeck(Profile|Folder|Widget)$/);
      const result = await importMacroDeck(exported.bytes, { password });
      assert.equal(
        result.config.pages[0].widgets[0].actions[0].value,
        "https://example.com",
      );
      if (password)
        await assert.rejects(
          importMacroDeck(exported.bytes, { password: "wrong-password" }),
          /authentication/,
        );
    }
  }
});
test("declared file hash and encrypted manifest tampering reject", async () => {
  const zip = readZip(archive(fixture()));
  const content = JSON.parse(zip.get("content.json").bytes);
  content.profile.name = "Tampered";
  zip.get("content.json").bytes = Buffer.from(JSON.stringify(content));
  await assert.rejects(importMacroDeck(writeZip(zip)), /integrity/);
  const e = await exportMacroDeck(
    (await importMacroDeck(archive(fixture()))).config,
    { password: "test-password-only" },
  );
  const z = readZip(e.bytes),
    m = JSON.parse(z.get("manifest.json").bytes);
  m.contents.name = "Tamper";
  z.get("manifest.json").bytes = Buffer.from(JSON.stringify(m));
  await assert.rejects(
    importMacroDeck(writeZip(z), { password: "test-password-only" }),
    /authentication/,
  );
});
test("merge preserves defaults, renames variables, and maps page links", async () => {
  const current = defaultConfig();
  current.variables = { count: 8 };
  const r = await importMacroDeck(archive(fixture()));
  r.config.variables = { count: 1 };
  const p = r.config.pages[0],
    w = p.widgets[0];
  w.label = "{{count}}";
  w.actions = [{ type: "increment", variable: "count", value: 1 }];
  p.widgets.push({
    id: "link",
    type: "page",
    label: "Home",
    targetPage: p.id,
    x: 2,
    y: 0,
    w: 1,
    h: 1,
    style: {},
  });
  const merged = mergeMacroDeckImport(current, r);
  assert.equal(merged.config.defaultProfileId, current.defaultProfileId);
  assert.equal(merged.config.variables.count, 8);
  assert.equal(merged.config.variables.count_2, 1);
  const added = merged.config.pages.at(-1);
  assert.notEqual(added.id, p.id);
  assert.equal(added.widgets[0].label, "{{count_2}}");
  assert.equal(added.widgets[0].actions[0].variable, "count_2");
  assert.equal(added.widgets[1].targetPage, added.id);
});
test("legacy JSON migrates folder hierarchy and inert plugin actions", async () => {
  const value = {
    ProfileId: "legacy",
    DisplayName: "Old",
    Rows: 3,
    Columns: 4,
    Folders: [
      {
        FolderId: "a",
        DisplayName: "*Root*",
        Childs: ["b"],
        ActionButtons: [
          {
            Guid: "button",
            Position_X: 1,
            Position_Y: 1,
            LabelOff: { LabelText: "Old button" },
            Actions: [{ $type: "Some.Plugin.Action" }],
          },
        ],
      },
      { FolderId: "b", DisplayName: "Child", ActionButtons: [] },
    ],
  };
  const result = await importMacroDeck(Buffer.from(JSON.stringify(value)));
  assert.equal(result.config.pages[1].parentId, result.config.pages[0].id);
  assert.equal(result.config.pages[0].widgets[0].label, "Old button");
  assert.ok(result.report.some((r) => r.code === "legacy-actions"));
});
test("ZIP parser rejects path traversal, special files, CRC and expansion limits", () => {
  assert.throws(() => writeZip({ "../x": Buffer.from("x") }), /unsafe/);
  assert.throws(
    () => readZip(writeZip({ x: { bytes: Buffer.from("x"), mode: 0o120777 } })),
    /symlinks/,
  );
  const bytes = writeZip({ safe: Buffer.from("content") }, { compress: false });
  bytes[34] ^= 1;
  assert.throws(() => readZip(bytes), /CRC/);
  assert.throws(
    () => readZip(writeZip({ safe: Buffer.alloc(1000) }), { maxBytes: 10 }),
    /expanded/,
  );
});
const hk = (key, salt, info, len) =>
  Buffer.from(hkdfSync("sha256", key, salt, Buffer.from(info), len));
function seal(key, nonce, data, aad) {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) c.setAAD(aad);
  return {
    data: Buffer.concat([c.update(data), c.final()]),
    tag: c.getAuthTag(),
  };
}
function recoveryText(key) {
  const data = Buffer.concat([
      key,
      hk(key, Buffer.alloc(0), "MacroDeck.Backup.v1.checksum", 2),
    ]),
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = 0,
    bits = 0,
    text = "";
  for (const b of data) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) text += alphabet[(value << (5 - bits)) & 31];
  return "MDBK1-" + text.match(/.{1,5}/g).join("-");
}
function backupArchive() {
  const profile = Buffer.from(JSON.stringify(fixture().profile)),
    database = Buffer.from("excluded fake database"),
    key = randomBytes(32),
    manifest = {
      formatVersion: 1,
      recoveryKeyId: hk(
        key,
        Buffer.alloc(0),
        "MacroDeck.Backup.v1.keyid",
        16,
      ).toString("hex"),
      encryption: {
        version: 1,
        cipher: "AES-256-GCM-STREAM",
        kdf: "HKDF-SHA256",
      },
    },
    mb = Buffer.from(JSON.stringify(manifest)),
    index = {
      entries: [
        {
          path: "files/data/profiles/profile.json",
          size: profile.length,
          sha256: hash(profile),
        },
      ],
      database: {
        path: "db/database.db",
        size: database.length,
        sha256: hash(database),
      },
    };
  const inner = writeZip({
    "manifest.json": mb,
    "content.json": Buffer.from(JSON.stringify(index)),
    "files/data/profiles/profile.json": profile,
    "db/database.db": database,
  });
  const salt = randomBytes(16),
    dek = randomBytes(32),
    nonce = randomBytes(12),
    wrap = seal(hk(key, salt, "MacroDeck.Backup.v1.kek", 32), nonce, dek, mb),
    prefix = randomBytes(7),
    header = Buffer.concat([
      Buffer.from("MDBK"),
      Buffer.from([1]),
      salt,
      nonce,
      wrap.data,
      wrap.tag,
      prefix,
      Buffer.from([16]),
    ]),
    segment = Buffer.concat([prefix, Buffer.alloc(4), Buffer.from([1])]),
    payload = seal(dek, segment, inner, header);
  return {
    bytes: writeZip({
      "manifest.json": mb,
      "payload.enc": Buffer.concat([header, payload.data, payload.tag]),
    }),
    recoveryKey: recoveryText(key),
  };
}
test("native recovery-key backup verifies/decrypts profiles without applying DB credentials", async () => {
  const backup = backupArchive(),
    r = await importMacroDeck(backup.bytes, {
      recoveryKey: backup.recoveryKey,
    });
  assert.equal(r.config.profiles[0].name, "Example");
  assert.ok(r.report.some((x) => x.code === "backup-scope"));
  const z = readZip(backup.bytes);
  z.get("payload.enc").bytes.at(-1);
  z.get("payload.enc").bytes[z.get("payload.enc").bytes.length - 1] ^= 1;
  await assert.rejects(
    importMacroDeck(writeZip(z), { recoveryKey: backup.recoveryKey }),
    /authentication/,
  );
  await assert.rejects(
    importMacroDeck(backup.bytes, { recoveryKey: "MDBK1-invalid" }),
    /recovery key/,
  );
});

test("archives produced by original Macro Deck C# sources are interoperable", async () => {
  const { readFileSync } = await import("node:fs");
  const base = new URL("./fixtures/macrodeck/", import.meta.url),
    info = JSON.parse(readFileSync(new URL("fixture-info.json", base)));
  const profile = await importMacroDeck(
    readFileSync(new URL("original-source.macroDeckProfile", base)),
    { password: info.password },
  );
  assert.equal(
    profile.config.pages[0].widgets[0].label,
    "Source fixture button",
  );
  const backup = await importMacroDeck(
    readFileSync(new URL("original-source.macroDeckBackup", base)),
    { recoveryKey: info.recoveryKey },
  );
  assert.equal(backup.config.profiles[0].name, "Source fixture");
});
