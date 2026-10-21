import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";

export function localAddresses() {
  return [
    ...new Set(
      Object.values(os.networkInterfaces())
        .flat()
        .filter(
          (a) =>
            a &&
            a.family === "IPv4" &&
            !a.internal &&
            /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address),
        )
        .map((a) => a.address),
    ),
  ];
}

// Stable per-install identity. The tablet receives its SHA-256 pin over authenticated USB.
export function loadIdentity(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, "wifi-key.pem");
  const certFile = path.join(dir, "wifi-cert.pem");
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    const tmpKey = keyFile + ".tmp",
      tmpCert = certFile + ".tmp";
    try {
      execFileSync(
        "/usr/bin/openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:3072",
          "-sha256",
          "-nodes",
          "-keyout",
          tmpKey,
          "-out",
          tmpCert,
          "-days",
          "3650",
          "-subj",
          "/CN=opendeck.local",
        ],
        { stdio: "ignore", timeout: 30000 },
      );
      fs.chmodSync(tmpKey, 0o600);
      fs.chmodSync(tmpCert, 0o600);
      fs.renameSync(tmpKey, keyFile);
      fs.renameSync(tmpCert, certFile);
    } finally {
      fs.rmSync(tmpKey, { force: true });
      fs.rmSync(tmpCert, { force: true });
    }
  }
  const key = fs.readFileSync(keyFile),
    cert = fs.readFileSync(certFile);
  return {
    key,
    cert,
    fingerprint: new X509Certificate(cert).fingerprint256
      .replaceAll(":", "")
      .toLowerCase(),
  };
}
