import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function saveAsset(dir, encoded) {
  if (typeof encoded !== "string" || encoded.length > 2800000)
    throw Error("이미지는 2MB 이하여야 합니다.");
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
    encoded,
  );
  if (!match) throw Error("PNG, JPEG, WebP 이미지를 선택하세요.");
  const bytes = Buffer.from(match[2], "base64");
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
  if ((!png && !jpg && !webp) || bytes.length > 2097152)
    throw Error("유효한 2MB 이하 이미지가 필요합니다.");
  const id = crypto.createHash("sha256").update(bytes).digest("hex");
  const root = path.join(dir, "assets");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, id), bytes, { mode: 0o600 });
  return { id, mime: png ? "image/png" : jpg ? "image/jpeg" : "image/webp" };
}
export function readAsset(dir, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("이미지를 찾을 수 없습니다.");
  const bytes = fs.readFileSync(path.join(dir, "assets", id));
  return {
    bytes,
    mime:
      bytes[0] === 137
        ? "image/png"
        : bytes[0] === 255
          ? "image/jpeg"
          : "image/webp",
  };
}
