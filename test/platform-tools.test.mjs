import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  platformToolsPackage,
  downloadPlatformTools,
} from "../host/system-tools.mjs";
import { writeZip } from "../host/safe-zip.mjs";
const pkg = (bytes) =>
  `<repository><remotePackage path="platform-tools"><revision><major>37</major><minor>0</minor><micro>1</micro></revision><channelRef ref="channel-0"/><archives><archive><complete><size>${bytes.length}</size><checksum>${createHash("sha1").update(bytes).digest("hex")}</checksum><url>platform-tools_r37.0.1-darwin.zip</url></complete><host-os>macosx</host-os></archive></archives></remotePackage></repository>`;
const make = () =>
  writeZip({
    "platform-tools/adb": {
      bytes: Buffer.from("test-only executable bytes"),
      mode: 0o100755,
    },
    "platform-tools/NOTICE.txt": Buffer.from("test fixture"),
  });
test("Google manifest default SHA1, stable channel and macOS package parsed", () => {
  const bytes = make(),
    p = platformToolsPackage(pkg(bytes), "darwin");
  assert.equal(p.version, "37.0.1");
  assert.equal(p.checksumAlgorithm, "sha1");
  assert.match(p.url, /^https:\/\/dl.google.com\/android\/repository\//);
  assert.throws(
    () =>
      platformToolsPackage(
        pkg(bytes).replace(
          "platform-tools_r37.0.1-darwin.zip",
          "https://evil.invalid/x",
        ),
        "darwin",
      ),
    /공식/,
  );
  assert.throws(() => platformToolsPackage(pkg(bytes), "linux"), /macOS/);
  assert.throws(
    () => platformToolsPackage('<!ENTITY x SYSTEM="file:///etc/passwd">'),
    "목록",
  );
});
test("official tools download validates checksum and installs privately and atomically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-tools-"));
  const bytes = make(),
    requests = [];
  try {
    const fetcher = async (url, opts) => {
      requests.push([url, opts]);
      return new Response(url.endsWith(".xml") ? pkg(bytes) : bytes);
    };
    const result = await downloadPlatformTools(dir, {
      fetcher,
      platform: "darwin",
    });
    assert.equal(
      fs.readFileSync(result.executablePath, "utf8"),
      "test-only executable bytes",
    );
    assert.equal(fs.statSync(result.executablePath).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.join(dir, "platform-tools")), [
      "37.0.1-" + result.checksum.slice(0, 16),
    ]);
    assert.ok(requests.every(([, opts]) => opts.redirect === "error"));
    const repeated = await downloadPlatformTools(dir, {
      fetcher,
      platform: "darwin",
    });
    assert.equal(repeated.executablePath, result.executablePath);
    fs.writeFileSync(result.executablePath, "changed");
    await assert.rejects(
      downloadPlatformTools(dir, { fetcher, platform: "darwin" }),
      /변경/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("bad checksum, malicious ZIP and redirect never leave an install", async () => {
  for (const kind of ["checksum", "traversal", "redirect"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-tools-"));
    try {
      const bytes =
        kind === "traversal"
          ? writeZip({ "unexpected/adb": Buffer.from("bad") })
          : make();
      const fetcher = async (url) =>
        kind === "redirect"
          ? { ok: true, redirected: true }
          : new Response(
              url.endsWith(".xml")
                ? pkg(bytes)
                : kind === "checksum"
                  ? Buffer.from("corrupt")
                  : bytes,
            );
      await assert.rejects(
        downloadPlatformTools(dir, { fetcher, platform: "darwin" }),
      );
      assert.deepEqual(fs.readdirSync(path.join(dir, "platform-tools")), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
test("tool installation directory cannot be a symlink", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-tools-")),
    other = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-tools-other-"));
  try {
    fs.symlinkSync(other, path.join(dir, "platform-tools"));
    await assert.rejects(
      downloadPlatformTools(dir, {
        fetcher: () => {
          throw Error("must not fetch");
        },
        platform: "darwin",
      }),
      /폴더/,
    );
    assert.deepEqual(fs.readdirSync(other), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
