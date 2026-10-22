import { createSecureContext } from "node:tls";
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

export function certificateInfo(dir) {
  const identity = loadIdentity(dir),
    cert = new X509Certificate(identity.cert);
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    fingerprint: identity.fingerprint,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    expired: Date.parse(cert.validTo) < Date.now(),
    notYetValid: Date.parse(cert.validFrom) > Date.now(),
    source: fs.existsSync(path.join(dir, "wifi-custom-certificate"))
      ? "custom"
      : "self-signed",
  };
}
export function installCertificate(dir, certificatePem, privateKeyPem) {
  if (
    typeof certificatePem !== "string" ||
    typeof privateKeyPem !== "string" ||
    certificatePem.length > 65536 ||
    privateKeyPem.length > 32768
  )
    throw Error("PEM 인증서와 개인 키를 확인하세요.");
  const cert = new X509Certificate(certificatePem);
  if (
    Date.parse(cert.validFrom) > Date.now() ||
    Date.parse(cert.validTo) <= Date.now()
  )
    throw Error("현재 유효한 인증서가 필요합니다.");
  // A TLS context verifies the certificate/key pair before any persistent files change.
  const context = createSecureContext({
    cert: certificatePem,
    key: privateKeyPem,
    minVersion: "TLSv1.2",
  });
  const current = loadIdentity(dir);
  const keyFile = path.join(dir, "wifi-key.pem"),
    certFile = path.join(dir, "wifi-cert.pem");
  try {
    fs.writeFileSync(keyFile + ".next", privateKeyPem, { mode: 0o600 });
    fs.writeFileSync(certFile + ".next", certificatePem, { mode: 0o600 });
    fs.renameSync(keyFile + ".next", keyFile);
    fs.renameSync(certFile + ".next", certFile);
    fs.writeFileSync(path.join(dir, "wifi-custom-certificate"), "1", {
      mode: 0o600,
    });
  } catch (e) {
    fs.writeFileSync(keyFile, current.key, { mode: 0o600 });
    fs.writeFileSync(certFile, current.cert, { mode: 0o600 });
    throw e;
  } finally {
    fs.rmSync(keyFile + ".next", { force: true });
    fs.rmSync(certFile + ".next", { force: true });
  }
  return context;
}
