package app.opendeck.client;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.*;

/** A self-signed local host is trusted only when its exact certificate was provisioned by USB. */
final class PinnedConnection {
  private static String cachedPin = "";
  private static SSLSocketFactory cachedFactory;

  private static synchronized SSLSocketFactory factory(String pin) throws Exception {
    if (pin.equals(cachedPin) && cachedFactory != null) return cachedFactory;
    X509TrustManager trust =
        new X509TrustManager() {
          public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
          }

          public void checkClientTrusted(X509Certificate[] c, String a)
              throws CertificateException {
            throw new CertificateException("Client certificates are not supported");
          }

          public void checkServerTrusted(X509Certificate[] chain, String auth)
              throws CertificateException {
            if (chain.length == 0 || !matches(chain[0], pin))
              throw new CertificateException("등록된 맥의 인증서와 다릅니다. USB로 다시 연결하세요.");
            chain[0].checkValidity();
          }
        };
    SSLContext tls = SSLContext.getInstance("TLS");
    tls.init(null, new TrustManager[] {trust}, null);
    cachedFactory = tls.getSocketFactory();
    cachedPin = pin;
    return cachedFactory;
  }

  static HttpURLConnection open(String address, String pin) throws Exception {
    URL url = new URL(address);
    if ("http".equals(url.getProtocol())) {
      if (!"127.0.0.1".equals(url.getHost()) || url.getPort() != 8840)
        throw new IOException("USB 로컬 주소만 HTTP로 연결할 수 있습니다.");
      return (HttpURLConnection) url.openConnection();
    }
    if (!"https".equals(url.getProtocol()) || !pin.matches("[0-9a-f]{64}"))
      throw new IOException("USB로 맥의 Wi-Fi 인증서를 먼저 등록하세요.");
    HttpsURLConnection c = (HttpsURLConnection) url.openConnection();
    c.setSSLSocketFactory(factory(pin));
    // Identity is the USB-provisioned certificate, independent of changing DHCP hostnames/IPs.
    c.setHostnameVerifier(
        (host, session) -> {
          try {
            return matches((X509Certificate) session.getPeerCertificates()[0], pin);
          } catch (Exception e) {
            return false;
          }
        });
    return c;
  }

  private static boolean matches(X509Certificate cert, String pin) {
    try {
      byte[] expected = new byte[32];
      for (int i = 0; i < expected.length; i++)
        expected[i] = (byte) Integer.parseInt(pin.substring(i * 2, i * 2 + 2), 16);
      return MessageDigest.isEqual(
          MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()), expected);
    } catch (Exception e) {
      return false;
    }
  }
}
