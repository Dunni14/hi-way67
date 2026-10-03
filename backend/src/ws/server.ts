// One phone at a time talks to us over a WebSocket at ws://<host>:PORT/phone.
// GET /health returns a small status JSON for quick checks.
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { PhoneMsg, type BackendMsg } from "./protocol.ts";

let phone: WebSocket | null = null;

export function isPhoneConnected() {
  return phone?.readyState === WebSocket.OPEN;
}

export function sendToPhone(msg: BackendMsg) {
  if (!isPhoneConnected()) {
    console.warn(`[ws] phone not connected, dropping ${msg.type}`);
    return false;
  }
  phone!.send(JSON.stringify(msg));
  return true;
}

export function startPhoneServer(
  port: number,
  onMessage: (msg: PhoneMsg) => void | Promise<void>,
  status: () => object,
) {
  const http = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, phoneConnected: isPhoneConnected(), ...status() }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, path: "/phone" });
  wss.on("connection", (ws, req) => {
    if (phone && phone !== ws) phone.close(4000, "replaced by new connection");
    phone = ws;
    console.log(`[ws] phone connected from ${req.socket.remoteAddress}`);

    ws.on("message", async (data) => {
      let parsed;
      try {
        parsed = PhoneMsg.safeParse(JSON.parse(data.toString()));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "invalid JSON" } satisfies BackendMsg));
        return;
      }
      if (!parsed.success) {
        ws.send(JSON.stringify({ type: "error", message: parsed.error.message } satisfies BackendMsg));
        return;
      }
      try {
        await onMessage(parsed.data);
      } catch (err) {
        console.error(`[ws] handler failed for ${parsed.data.type}:`, err);
      }
    });

    ws.on("close", () => {
      if (phone === ws) phone = null;
      console.log("[ws] phone disconnected");
    });
  });

  http.listen(port, () => console.log(`[ws] listening on :${port} (ws path /phone, GET /health)`));
}
