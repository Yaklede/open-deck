// One accepted write and one replaceable snapshot keep a slow client bounded.
// A false write result means Node accepted the bytes, not that the frame failed.
export class LatestSnapshotStream {
  constructor(response, { stallTimeoutMs = 15000, onClose = () => {} } = {}) {
    this.response = response;
    this.stallTimeoutMs = stallTimeoutMs;
    this.onClose = onClose;
    this.closed = false;
    this.blocked = false;
    this.pending = null;
    this.blockedAt = 0;
    this.timer = null;
    this.handleDrain = () => {
      if (this.closed) return;
      this.clearStall();
      this.flush();
    };
    this.handleClose = () => this.finish("client_closed");
    this.handleError = () => this.close("write_error", true);
    response.on("drain", this.handleDrain);
    response.once("close", this.handleClose);
    response.once("finish", this.handleClose);
    response.once("error", this.handleError);
  }

  snapshot(prepare) {
    if (this.closed) return;
    // Preparing only when writable also delays authorization/revision checks
    // until the queued frame can actually be sent.
    this.pending = prepare;
    this.flush();
  }

  flush() {
    if (this.closed || this.blocked || !this.pending) return;
    const prepare = this.pending;
    this.pending = null;
    try {
      const frame = prepare();
      if (this.closed || !frame) return;
      this.write(`event: snapshot\ndata: ${JSON.stringify(frame.data)}\n\n`, frame.onWritten);
    } catch {
      this.close("snapshot_error", true);
    }
  }

  comment(value = "heartbeat") {
    // A heartbeat never grows the write queue or replaces an application frame.
    if (!this.closed && !this.blocked) this.write(`: ${value}\n\n`);
  }

  write(bytes, onWritten) {
    if (this.closed) return;
    if (this.response.destroyed || this.response.writableEnded) {
      this.finish("response_closed");
      return;
    }
    try {
      const writable = this.response.write(bytes);
      onWritten?.();
      if (!writable && !this.closed) {
        this.blocked = true;
        this.blockedAt = Date.now();
        this.timer = setTimeout(
          () => this.close("backpressure_timeout", true),
          this.stallTimeoutMs,
        );
        this.timer.unref?.();
      }
    } catch {
      this.close("write_error", true);
    }
  }

  clearStall() {
    clearTimeout(this.timer);
    this.timer = null;
    this.blocked = false;
    this.blockedAt = 0;
  }

  finish(reason) {
    if (this.closed) return false;
    const durationMs = this.blockedAt ? Date.now() - this.blockedAt : 0;
    this.closed = true;
    this.pending = null;
    this.clearStall();
    this.response.off("drain", this.handleDrain);
    this.response.off("close", this.handleClose);
    this.response.off("finish", this.handleClose);
    this.response.off("error", this.handleError);
    this.onClose({ reason, durationMs });
    return true;
  }

  close(reason = "server_closed", destroy = false) {
    if (!this.finish(reason)) return;
    if (destroy) this.response.destroy();
    else this.response.end();
  }
}
