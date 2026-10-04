// Demo control: a slider page at GET /demo that sets the speed a phone in demo mode reports.
// Mounted on the same HTTP server as the phone WebSocket; returns false when the path isn't ours.
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { isPhoneConnected, sendToPhone } from "../ws/server.ts";

export const DEMO_MAX_MPH = 120;
const SpeedBody = z.object({ mph: z.number().min(0).max(DEMO_MAX_MPH) });
const PAGE = new URL("./demo.html", import.meta.url);

/** Last speed set from the slider; null until it is first used. Re-sent to a phone that connects later. */
let demoMph: number | null = null;

/** The slider's current value, for a phone that (re)connects mid-demo. */
export function currentDemoSpeed() {
  return demoMph;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1024) return null;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function demoRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0]!.replace(/\/$/, "");
  if (req.method === "GET" && path === "/demo") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(await readFile(PAGE));
    return true;
  }
  if (req.method === "GET" && path === "/demo/state") {
    json(res, 200, { mph: demoMph, phoneConnected: isPhoneConnected() });
    return true;
  }
  if (req.method === "POST" && path === "/demo/speed") {
    const body = SpeedBody.safeParse(await readBody(req));
    if (!body.success) {
      json(res, 400, { error: `mph must be a number from 0 to ${DEMO_MAX_MPH}` });
      return true;
    }
    demoMph = body.data.mph;
    const phoneConnected = isPhoneConnected();
    if (phoneConnected) sendToPhone({ type: "demo_speed", mph: demoMph });
    json(res, 200, { mph: demoMph, phoneConnected });
    return true;
  }
  return false;
}
