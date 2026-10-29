export function downloadFile(
  filename,
  content,
  mime = "application/octet-stream",
) {
  if (
    typeof filename !== "string" ||
    /[\x00-\x1f/\\:]/.test(filename) ||
    filename.length > 180
  )
    throw Error("Invalid export filename");
  const native = globalThis.window?.webkit?.messageHandlers?.exportFile;
  if (native) {
    if (typeof content === "string")
      native.postMessage({ filename, text: content });
    else {
      const bytes =
        content instanceof Uint8Array ? content : new Uint8Array(content);
      let encoded = "";
      for (let i = 0; i < bytes.length; i += 8192)
        encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
      native.postMessage({ filename, dataBase64: btoa(encoded) });
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
