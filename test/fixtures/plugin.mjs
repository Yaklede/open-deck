import { WebSocket } from "ws";
const url = process.env.MACRO_DECK_PLUGIN_HOST_URL;
let value = 7;
const res = await fetch(url + "/api/plugins/sessions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "X-MacroDeck-Plugin-Id": process.env.MACRO_DECK_PLUGIN_ID,
    "X-MacroDeck-Plugin-Secret": process.env.MACRO_DECK_PLUGIN_SECRET,
  },
  body: JSON.stringify({
    requestedVersion: { minimum: 3, maximum: 3 },
    capabilities: [
      {
        kind: "actions",
        localId: "increase",
        versionRange: { minimum: 3, maximum: 3 },
      },
      {
        kind: "variables",
        localId: "counter",
        versionRange: { minimum: 2, maximum: 2 },
      },
      {
        kind: "ui",
        localId: "custom",
        versionRange: { minimum: 1, maximum: 1 },
      },
    ],
  }),
});
const session = await res.json();
const ws = new WebSocket(
  url.replace("http:", "ws:") + "/plugins/ws",
  "macrodeck.plugin.v1",
  { headers: { Authorization: "Bearer " + session.sessionToken } },
);
ws.on("open", () =>
  ws.send(
    JSON.stringify({
      type: "session.hello",
      id: "hello",
      payload: { sessionId: session.sessionId },
    }),
  ),
);
ws.on("message", (raw) => {
  const e = JSON.parse(raw);
  if (e.type !== "capability.invoke") return;
  const p = e.payload;
  let data = {};
  if (p.operation === "describe")
    data =
      p.kind === "actions"
        ? { actions: [{ localId: "increase", parameters: [] }] }
        : { variables: [{ id: "counter", name: "counter", type: "Numeric" }] };
  else if (p.operation === "get")
    data = { value: { kind: "number", number: value } };
  else if (p.operation === "execute") value++;
  ws.send(
    JSON.stringify({
      type: "capability.result",
      id: crypto.randomUUID(),
      correlationId: e.id,
      payload: { data },
    }),
  );
});
