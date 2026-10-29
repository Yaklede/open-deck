import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LatestSnapshotStream } from "../host/sse-stream.mjs";

class Response extends EventEmitter {
  frames = [];
  writable = true;
  destroyed = false;
  writableEnded = false;
  write(frame) {
    this.frames.push(frame);
    return this.writable;
  }
  end() {
    this.writableEnded = true;
    this.emit("finish");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("SSE coalesces slow-client snapshots and commits revisions only when written", () => {
  const response = new Response();
  const channel = new LatestSnapshotStream(response);
  const prepared = [], committed = [];
  const enqueue = (revision) => channel.snapshot(() => {
    prepared.push(revision);
    return { data: { revision }, onWritten: () => committed.push(revision) };
  });
  response.writable = false;
  enqueue(1);
  for (let i = 2; i <= 100; i++) enqueue(i);
  assert.deepEqual(prepared, [1]);
  assert.deepEqual(committed, [1], "write(false) still accepted the first frame");
  assert.equal(response.frames.length, 1);
  channel.comment();
  assert.equal(response.frames.length, 1, "heartbeat cannot grow a blocked queue");
  response.writable = true;
  response.emit("drain");
  assert.deepEqual(prepared, [1, 100]);
  assert.deepEqual(committed, [1, 100]);
  assert.match(response.frames[1], /"revision":100/);
  assert.equal(channel.pending, null);
  assert.equal(channel.blocked, false);
  channel.close();
});

test("a single large accepted frame is not closed merely because it exceeds 256 KB", () => {
  const response = new Response();
  response.writable = false;
  const channel = new LatestSnapshotStream(response);
  channel.snapshot(() => ({ data: { value: "x".repeat(500000) } }));
  channel.snapshot(() => ({ data: { value: "latest" } }));
  assert.equal(channel.closed, false);
  assert.equal(response.destroyed, false);
  response.writable = true;
  response.emit("drain");
  assert.equal(response.frames.length, 2);
  assert.equal(channel.timer, null);
  channel.close();
});

test("persistent backpressure closes once with a reason and releases queued work", async () => {
  const response = new Response(), closed = [];
  response.writable = false;
  const channel = new LatestSnapshotStream(response, {
    stallTimeoutMs: 25,
    onClose: (event) => closed.push(event),
  });
  channel.comment();
  let prepared = false;
  channel.snapshot(() => { prepared = true; return { data: {} }; });
  await pause(60);
  assert.equal(response.destroyed, true);
  assert.equal(prepared, false);
  assert.equal(channel.pending, null);
  assert.equal(channel.timer, null);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, "backpressure_timeout");
  assert.ok(closed[0].durationMs >= 20);
  assert.equal(response.listenerCount("drain"), 0);
  response.emit("drain");
  channel.close();
  assert.equal(closed.length, 1);
});

test("drain cancels the stall timeout and a later blocked write starts a new deadline", async () => {
  const response = new Response();
  response.writable = false;
  const channel = new LatestSnapshotStream(response, { stallTimeoutMs: 35 });
  channel.comment();
  response.writable = true;
  response.emit("drain");
  await pause(60);
  assert.equal(channel.closed, false);
  response.writable = false;
  channel.comment();
  await pause(60);
  assert.equal(channel.closed, true);
});

test("closing or revoking a stream discards pending snapshots without writing them", async () => {
  const response = new Response(), closed = [];
  response.writable = false;
  const channel = new LatestSnapshotStream(response, {
    stallTimeoutMs: 25,
    onClose: (event) => closed.push(event.reason),
  });
  channel.snapshot(() => ({ data: { first: true } }));
  channel.snapshot(() => { throw Error("revoked data must not be prepared"); });
  channel.close("device_revoked", true);
  response.emit("drain");
  await pause(50);
  assert.deepEqual(closed, ["device_revoked"]);
  assert.equal(response.frames.length, 1);
});

test("queued snapshot authorization is evaluated again at drain time", () => {
  const response = new Response();
  response.writable = false;
  const channel = new LatestSnapshotStream(response);
  channel.comment();
  let allowed = true, committed = false;
  channel.snapshot(() => {
    if (!allowed) { channel.close("device_revoked", true); return null; }
    return { data: {}, onWritten: () => { committed = true; } };
  });
  allowed = false;
  response.emit("drain");
  assert.equal(committed, false);
  assert.equal(response.destroyed, true);
  assert.deepEqual(response.frames, [": heartbeat\n\n"]);
});

test("write and serialization errors close safely without committing unsent revisions", () => {
  for (const kind of ["write", "serialize"]) {
    const response = new Response(), closed = [];
    const channel = new LatestSnapshotStream(response, { onClose: (event) => closed.push(event.reason) });
    let committed = false;
    if (kind === "write") response.write = () => { throw Error("socket unavailable"); };
    const data = {};
    if (kind === "serialize") data.circular = data;
    assert.doesNotThrow(() => channel.snapshot(() => ({ data, onWritten: () => { committed = true; } })));
    assert.equal(committed, false);
    assert.equal(response.destroyed, true);
    assert.deepEqual(closed, [kind === "write" ? "write_error" : "snapshot_error"]);
  }
});

test("client disconnect cancels the stall deadline and unregisters stream listeners", async () => {
  const response = new Response(), closed = [];
  response.writable = false;
  const channel = new LatestSnapshotStream(response, {
    stallTimeoutMs: 25,
    onClose: (event) => closed.push(event.reason),
  });
  channel.comment();
  response.emit("close");
  await pause(50);
  assert.deepEqual(closed, ["client_closed"]);
  assert.equal(channel.timer, null);
  for (const event of ["drain", "close", "finish", "error"])
    assert.equal(response.listenerCount(event), 0);
});
