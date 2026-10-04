// REST routes for the risk engine (spec §2, §7, §8). Mounted on the same HTTP
// server as the phone WebSocket; returns false when the path isn't ours.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { HttpError, type RiskService } from "../risk/service.ts";
import { Feedback, SignalWindow, TripStart } from "../risk/types.ts";

const MAX_BODY = 64 * 1024;
const StartBody = TripStart.extend({ sharing_mode: z.enum(["always", "high_only", "never"]).optional() });

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export function createRiskRoutes(svc: RiskService) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const m = req.method ?? "GET";
    const [a, id, b] = parts;

    const isTrips = a === "trips" && parts.length <= 3;
    const isDrivers = a === "drivers" && id && (b === "trips" || b === "profile" || b === "stats") && parts.length === 3;
    const isPolicy = a === "drivers" && id && b === "policy" && parts.length === 3;
    if (!isTrips && !isDrivers && !isPolicy) return false;

    try {
      if (m === "POST" && a === "trips" && parts.length === 1) {
        send(res, 201, await svc.startTrip(StartBody.parse(await readJson(req))));
      } else if (m === "POST" && a === "trips" && b === "windows" && id) {
        send(res, 200, await svc.ingestWindow(id, SignalWindow.parse(await readJson(req))));
      } else if (m === "POST" && a === "trips" && b === "feedback" && id) {
        send(res, 200, await svc.feedback(id, Feedback.parse(await readJson(req))));
      } else if (m === "POST" && a === "trips" && b === "end" && id) {
        send(res, 200, await svc.endTrip(id));
      } else if (m === "GET" && a === "trips" && b === "report" && id) {
        send(res, 200, await svc.report(id));
      } else if (m === "GET" && a === "trips" && b === "state" && id) {
        send(res, 200, await svc.state(id));
      } else if (m === "GET" && a === "trips" && b === "card" && id) {
        send(res, 200, await svc.card(id));
      } else if (m === "GET" && a === "trips" && b === "observations" && id) {
        send(res, 200, await svc.observations(id));
      } else if (m === "GET" && isDrivers && b === "stats") {
        const days = Math.min(31, Math.max(1, Number(url.searchParams.get("days")) || 7));
        send(res, 200, await svc.stats(id!, days));
      } else if (m === "GET" && isDrivers && b === "profile") {
        send(res, 200, await svc.profile(id!));
      } else if (m === "GET" && isPolicy) {
        send(res, 200, await svc.driverPolicy(id!));
      } else if (m === "GET" && isDrivers) {
        send(res, 200, await svc.driverTrips(id!));
      } else {
        return false;
      }
    } catch (err) {
      if (err instanceof z.ZodError) send(res, 400, { error: "invalid request", issues: err.issues });
      else if (err instanceof HttpError) send(res, err.status, { error: err.message });
      else {
        console.error("[risk-http]", err);
        send(res, 500, { error: "internal error" });
      }
    }
    return true;
  };
}
