import { createSecureContext } from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";

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
    source: fs.existsSync(path.join(dir, "wifi-local-ca-issued"))
      ? "local-ca"
      : fs.existsSync(path.join(dir, "wifi-custom-certificate"))
        ? "custom"
        : "self-signed",
    authority: authorityInfo(dir),
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
    fs.rmSync(path.join(dir, "wifi-local-ca-issued"), { force: true });
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

export function authorityInfo(dir) {
  const file = path.join(dir, "wifi-ca-cert.pem");
  if (!fs.existsSync(file)) return { configured: false };
  const cert = new X509Certificate(fs.readFileSync(file));
  return {
    configured: true,
    subject: cert.subject,
    fingerprint: cert.fingerprint256.replaceAll(":", "").toLowerCase(),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    expired: Date.parse(cert.validTo) <= Date.now(),
  };
}

export function exportAuthority(dir) {
  const info = authorityInfo(dir);
  if (!info.configured) throw Error("로컬 인증기관이 아직 없습니다.");
  return {
    ...info,
    certificatePem: fs.readFileSync(path.join(dir, "wifi-ca-cert.pem"), "utf8"),
  };
}

// The authority private key never leaves the local data directory. Only the public CA
// certificate can be exported; Android continues to pin the paired leaf certificate.
export function issueLocalCertificate(
  dir,
  { rotateAuthority = false, addresses = localAddresses() } = {},
) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = [
    "wifi-key.pem",
    "wifi-cert.pem",
    "wifi-ca-key.pem",
    "wifi-ca-cert.pem",
    "wifi-local-ca-issued",
    "wifi-custom-certificate",
  ];
  const before = new Map(
    names.map((name) => [
      name,
      fs.existsSync(path.join(dir, name))
        ? fs.readFileSync(path.join(dir, name))
        : null,
    ]),
  );
  const tmp = fs.mkdtempSync(path.join(dir, ".certificate-"));
  fs.chmodSync(tmp, 0o700);
  const run = (args) =>
    execFileSync("/usr/bin/openssl", args, { stdio: "ignore", timeout: 30000 });
  try {
    const caKey = path.join(tmp, "ca-key.pem"),
      caCert = path.join(tmp, "ca-cert.pem");
    if (rotateAuthority || !authorityInfo(dir).configured) {
      const caConfig = path.join(tmp, "ca.cnf");
      fs.writeFileSync(
        caConfig,
        "[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nCN=Open Deck Local Authority\n[v3_ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n",
        { mode: 0o600 },
      );
      run([
        "req",
        "-x509",
        "-newkey",
        "rsa:3072",
        "-sha256",
        "-nodes",
        "-keyout",
        caKey,
        "-out",
        caCert,
        "-days",
        "3650",
        "-config",
        caConfig,
      ]);
    } else {
      fs.copyFileSync(path.join(dir, "wifi-ca-key.pem"), caKey);
      fs.copyFileSync(path.join(dir, "wifi-ca-cert.pem"), caCert);
      if (authorityInfo(dir).expired)
        throw Error("로컬 인증기관이 만료되었습니다. 인증기관을 재생성하세요.");
    }
    const key = path.join(tmp, "leaf-key.pem"),
      cert = path.join(tmp, "leaf-cert.pem"),
      csr = path.join(tmp, "leaf.csr"),
      ext = path.join(tmp, "leaf.cnf");
    const ips = [...new Set(["127.0.0.1", ...addresses])].filter(
      (ip) =>
        /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
        ip.split(".").every((v) => +v <= 255),
    );
    fs.writeFileSync(
      ext,
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:opendeck.local,DNS:localhost," +
        ips.map((ip) => "IP:" + ip).join(",") +
        "\n",
      { mode: 0o600 },
    );
    run([
      "req",
      "-new",
      "-newkey",
      "rsa:3072",
      "-sha256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      "/CN=opendeck.local",
    ]);
    run([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-set_serial",
      "0x" + randomBytes(16).toString("hex"),
      "-out",
      cert,
      "-days",
      "397",
      "-sha256",
      "-extfile",
      ext,
    ]);
    const pem = fs.readFileSync(cert, "utf8"),
      privateKey = fs.readFileSync(key, "utf8");
    const leaf = new X509Certificate(pem),
      authority = new X509Certificate(fs.readFileSync(caCert));
    if (!leaf.verify(authority.publicKey) || !authority.ca)
      throw Error("인증서 체인을 확인할 수 없습니다.");
    installCertificate(dir, pem, privateKey);
    for (const [name, file] of [
      ["wifi-ca-key.pem", caKey],
      ["wifi-ca-cert.pem", caCert],
    ]) {
      fs.writeFileSync(path.join(dir, name), fs.readFileSync(file), {
        mode: 0o600,
      });
      fs.chmodSync(path.join(dir, name), 0o600);
    }
    fs.writeFileSync(path.join(dir, "wifi-local-ca-issued"), "1", {
      mode: 0o600,
    });
    fs.rmSync(path.join(dir, "wifi-custom-certificate"), { force: true });
    return loadIdentity(dir);
  } catch (e) {
    for (const [name, value] of before) {
      const file = path.join(dir, name);
      if (value === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, value, { mode: 0o600 });
    }
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
