import http from "node:http";
import https from "node:https";

const close = (server) =>
  new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(resolve);
    server.closeAllConnections();
  });

/** Transactional listener changes. Existing healthy listeners survive failed binds. */
export class NetworkListeners {
  constructor({ handler, identity, onChange = () => {}, onError = () => {} }) {
    this.handler = handler;
    this.identity = identity;
    this.onChange = onChange;
    this.onError = onError;
    this.entries = [];
    this.pending = null;
    this.starting = null;
  }
  get primary() {
    return (
      this.entries.find((e) => e.kind === "https")?.server ||
      this.entries[0]?.server ||
      this.starting
    );
  }
  get tls() {
    return this.entries.find((e) => e.kind === "https")?.server;
  }
  get plain() {
    return this.entries.find((e) => e.kind === "http")?.server;
  }
  endpoints(addresses) {
    return [...this.entries]
      .sort((a, b) => Number(b.kind === "https") - Number(a.kind === "https"))
      .flatMap((e) =>
        e.server.listening
          ? addresses.map(
              (ip) => `${e.kind}://${ip}:${e.server.address().port}`,
            )
          : [],
      );
  }
  configure(settings, firstPort) {
    const run = () => this.apply(settings, firstPort);
    const result = this.pending ? this.pending.then(run, run) : run();
    this.pending = result.catch(() => {});
    return result;
  }
  desired(settings, firstPort) {
    if (!settings.wifiEnabled) return [];
    const port = firstPort ?? settings.wifiPort;
    if (!settings.tlsEnabled) return [{ kind: "http", port }];
    if (settings.tlsMode === "Additional")
      return [
        { kind: "http", port },
        { kind: "https", port: settings.tlsHttpsPort },
      ];
    return [{ kind: "https", port }];
  }
  async create(spec) {
    const identity = spec.kind === "https" ? this.identity() : null;
    const server = identity
      ? https.createServer(
          { key: identity.key, cert: identity.cert, minVersion: "TLSv1.2" },
          this.handler,
        )
      : http.createServer(this.handler);
    if (!this.entries.length) this.starting = server;
    await new Promise((resolve, reject) => {
      const fail = (error) => {
        server.removeListener("listening", ready);
        reject(error);
      };
      const ready = () => {
        server.removeListener("error", fail);
        resolve();
      };
      server.once("error", fail);
      server.once("listening", ready);
      server.listen(spec.port, "0.0.0.0");
    });
    server.on("error", this.onError);
    return { ...spec, port: server.address().port, server };
  }
  async apply(settings, firstPort) {
    const desired = this.desired(settings, firstPort),
      previous = [...this.entries];
    const reused = [],
      created = [],
      retired = [];
    const missing = desired.filter((spec) => {
      const old = previous.find(
        (e) => e.kind === spec.kind && e.port === spec.port,
      );
      if (old) {
        reused.push(old);
        return false;
      }
      return true;
    });
    try {
      // Bind free ports first. Protocol changes on an occupied port require a short
      // close/rebind window; rollback restores the original protocol on failure.
      for (const spec of missing.filter(
        (s) => !previous.some((e) => e.port === s.port),
      ))
        created.push(await this.create(spec));
      for (const spec of missing.filter((s) =>
        previous.some((e) => e.port === s.port),
      )) {
        const conflict = previous.find((e) => e.port === spec.port);
        retired.push(conflict);
        await close(conflict.server);
        created.push(await this.create(spec));
      }
      this.entries = [...reused, ...created];
      this.starting = null;
      this.onChange();
      await Promise.all(
        previous
          .filter((e) => !reused.includes(e) && !retired.includes(e))
          .map((e) => close(e.server)),
      );
    } catch (e) {
      await Promise.all(created.map((e) => close(e.server)));
      this.entries = previous.filter((e) => !retired.includes(e));
      this.starting = null;
      for (const old of retired) this.entries.push(await this.create(old));
      this.starting = null;
      this.onChange();
      throw e;
    }
  }
  updateIdentity() {
    const identity = this.identity();
    this.tls?.setSecureContext({
      key: identity.key,
      cert: identity.cert,
      minVersion: "TLSv1.2",
    });
  }
  async close() {
    await this.pending;
    await Promise.all(this.entries.map((e) => close(e.server)));
    this.entries = [];
    this.starting = null;
  }
}
