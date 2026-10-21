import fs from "node:fs";
import path from "node:path";
import os from "node:os";
let busy = false;
export function sessionWindowIds(data) {
  if (data.length < 8 || data.subarray(0, 4).toString() !== "SNSS") return [];
  let offset = 8;
  const ids = new Set();
  while (offset + 2 <= data.length) {
    const size = data.readUInt16LE(offset);
    offset += 2;
    if (size < 1 || offset + size > data.length) break;
    if (data[offset] === 0 && size >= 9)
      ids.add(String(data.readInt32LE(offset + 1)));
    offset += size;
  }
  return [...ids];
}
const script = `function run(a){var c=Application(Number(a[0])),ids=JSON.parse(a[1]),prefix=a[2],ws=c.windows();for(var i=0;i<ws.length;i++){var w=ws[i];if(ids.indexOf(String(w.id()))<0||w.mode()!=='normal')continue;if(!prefix)return 'open';var us=w.tabs.url(),idx=w.activeTabIndex()-1;if(idx<0||!us[idx]||us[idx].indexOf(prefix)!==0){idx=-1;for(var j=0;j<us.length;j++)if(us[j]&&us[j].indexOf(prefix)===0){idx=j;break;}}if(idx>=0){w.minimized=false;w.activeTabIndex=idx+1;w.index=1;c.activate();return 'focused';}}return 'missing';}`;
export async function chrome(profile, url, runner) {
  if (!profile || profile.includes("/") || profile === "." || profile === "..")
    throw Error("Chrome 프로필 폴더가 잘못되었습니다.");
  if (url && !/^https?:\/\//.test(url))
    throw Error("http/https URL이 필요합니다.");
  if (busy) return "ignored";
  busy = true;
  try {
    const exe = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const rows = (await runner("/bin/ps", ["-axo", "pid=,args="], 1000)).split(
      "\n",
    );
    let pid = "0";
    for (const row of rows) {
      const m = row.trim().match(/^(\d+)\s+(.+)$/);
      if (
        m &&
        (m[2] === exe || m[2].startsWith(exe + " ")) &&
        !m[2].includes("--user-data-dir=")
      ) {
        pid = m[1];
        break;
      }
    }
    const dir = path.join(
      os.homedir(),
      "Library/Application Support/Google/Chrome",
      profile,
      "Sessions",
    );
    let ids = [];
    try {
      const latest = fs
        .readdirSync(dir)
        .filter((n) => n.startsWith("Session_"))
        .sort()
        .at(-1);
      if (latest)
        ids = sessionWindowIds(fs.readFileSync(path.join(dir, latest)));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const prefix = url ? new URL(url).href.split("#")[0] : "";
    const result =
      pid === "0"
        ? "missing"
        : await runner(
            "/usr/bin/osascript",
            [
              "-l",
              "JavaScript",
              "-e",
              script,
              pid,
              JSON.stringify(ids),
              prefix,
            ],
            1500,
          );
    if (result === "missing") {
      await runner(
        "/usr/bin/open",
        [
          "-na",
          "/Applications/Google Chrome.app",
          "--args",
          "--profile-directory=" + profile,
          ...(url ? [url] : []),
        ],
        2000,
      );
      return "opened";
    }
    return result;
  } finally {
    busy = false;
  }
}
