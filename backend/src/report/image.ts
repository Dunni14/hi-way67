// Drive report card as a PNG, for the iMessage / Telegram attachment and GET /trips/{id}/card.png.
// satori lays out a flexbox tree and returns SVG (text becomes paths, so no system fonts are needed),
// resvg rasterizes it. No browser. Pure apart from reading the bundled Inter font once.
// Colors follow the dataviz palette: one blue series, text in ink tokens, thin rounded meter bars.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { CATEGORIES, type Category, type ReportCard } from "../risk/card.ts";
import { tripNarrative } from "./narrative.ts";

const W = 1080;
const H = 1960;
const C = {
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  ink2: "#52514e",
  muted: "#8a8984",
  line: "#e6e5e1",
  track: "#ecebe7",
  panel: "#f4f3ef",
  series: "#2a78d6",
};

const fontDir = join(dirname(createRequire(import.meta.url).resolve("@fontsource/inter/package.json")), "files");
let fonts: { name: string; data: Buffer; weight: 400 | 600 | 700; style: "normal" }[] | undefined;
const loadFonts = () =>
  (fonts ??= ([400, 600, 700] as const).map((weight) => ({ name: "Inter", data: readFileSync(join(fontDir, `inter-latin-${weight}-normal.woff`)), weight, style: "normal" as const })));

type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };
const el = (style: Record<string, unknown>, ...children: unknown[]): Node => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children: children.length === 1 ? children[0] : children },
});
const text = (s: string, style: Record<string, unknown> = {}) => el({ ...style }, s);

const LABELS: Record<Category, string> = { attention: "Attention", speed: "Speed", smoothness: "Smoothness", alertness: "Alertness", composure: "Composure" };
const VERDICT = { A: "Excellent drive", B: "Good drive", C: "Fair drive", D: "Poor drive", F: "Unsafe drive" } as const;
const EXPRESSION_LINE: Record<string, string> = {
  calm: "Mostly calm", neutral: "Mostly neutral", stressed: "Looked stressed", drowsy: "Looked drowsy", distracted: "Often distracted", no_face: "Face often out of view",
};

export type ReportMeta = { driverName: string; startedAt?: Date | number | string | null };

const fmtDate = (d: Date) =>
  `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
const fmtDuration = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`);

function stat(label: string, value: string, unit: string) {
  return el(
    { flex: 1, flexDirection: "column", border: `2px solid ${C.line}`, borderRadius: 24, padding: "28px 30px" },
    text(label, { fontSize: 26, color: C.ink2, fontWeight: 400 }),
    el({ alignItems: "baseline", marginTop: 10 }, text(value, { fontSize: 76, fontWeight: 700, color: C.ink, letterSpacing: -2 }), text(unit, { fontSize: 28, color: C.muted, marginLeft: 8 })),
  );
}

function small(label: string, value: string) {
  return el(
    { flex: 1, flexDirection: "column", backgroundColor: C.panel, borderRadius: 20, padding: "20px 24px" },
    text(label, { fontSize: 22, color: C.ink2 }),
    text(value, { marginTop: 6, fontSize: 40, fontWeight: 700, letterSpacing: -1 }),
  );
}

const row = (...tiles: Node[]) => el({ marginTop: 16 }, ...tiles.flatMap((t, i) => (i ? [el({ width: 16 }), t] : [t])));
const secs = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

function meter(label: string, value: number) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return el(
    { alignItems: "center", marginTop: 22 },
    text(label, { width: 240, fontSize: 28, color: C.ink }),
    el({ flex: 1, height: 18, borderRadius: 9, backgroundColor: C.track }, el({ width: `${v}%`, height: 18, borderRadius: 9, backgroundColor: C.series })),
    text(String(v), { width: 84, justifyContent: "flex-end", fontSize: 28, fontWeight: 600, color: C.ink }),
  );
}

export function reportTree(card: ReportCard, meta: ReportMeta): Node {
  const m = card.metrics;
  const started = meta.startedAt == null ? null : new Date(meta.startedAt);
  const sub = [started ? fmtDate(started) : null, fmtDuration(m.duration_s), `${m.distance_mi.toFixed(1)} mi`].filter(Boolean).join("  ·  ");
  const warnings = m.interventions.voice_nudge + m.interventions.voice_warning + m.interventions.voice_urgent;
  const facts = [
    m.interventions.notify_contacts ? "Contacts notified" : "No contacts needed",
    card.expression.dominant ? EXPRESSION_LINE[card.expression.dominant] : null,
  ].filter(Boolean);

  return el(
    { width: W, height: H, flexDirection: "column", justifyContent: "space-between", backgroundColor: C.surface, padding: 64, fontFamily: "Inter", color: C.ink },
    el(
      { flexDirection: "column" },
      el(
        { justifyContent: "space-between", alignItems: "center" },
        text("DRIVER GUARDIAN", { fontSize: 24, fontWeight: 600, letterSpacing: 4, color: C.ink2 }),
        text("Drive report", { fontSize: 24, color: C.muted }),
      ),
      text(`${meta.driverName}'s drive`, { marginTop: 36, fontSize: 64, fontWeight: 700, letterSpacing: -1.5 }),
      text(sub, { marginTop: 10, fontSize: 28, color: C.ink2 }),

      el(
        { marginTop: 44, alignItems: "center", justifyContent: "space-between", border: `2px solid ${C.line}`, borderRadius: 28, padding: "36px 44px" },
        el(
          { flexDirection: "column" },
          text("Safety score", { fontSize: 26, color: C.ink2 }),
          el({ alignItems: "baseline", marginTop: 4 }, text(String(Math.round(card.score)), { fontSize: 168, fontWeight: 700, letterSpacing: -6, lineHeight: 1 }), text("/100", { fontSize: 40, color: C.muted, marginLeft: 10 })),
          card.provisional ? text("Short drive: provisional score", { marginTop: 12, fontSize: 24, color: C.muted }) : text(VERDICT[card.grade], { marginTop: 12, fontSize: 28, color: C.ink2 }),
        ),
        el(
          { flexDirection: "column", alignItems: "center", justifyContent: "center", width: 200, height: 200, borderRadius: 100, border: `10px solid ${C.series}` },
          text(card.grade, { fontSize: 104, fontWeight: 700, color: C.ink, lineHeight: 1 }),
          text("GRADE", { fontSize: 20, fontWeight: 600, letterSpacing: 3, color: C.ink2, marginTop: 2 }),
        ),
      ),

      el(
        { marginTop: 28 },
        stat("Average speed", String(Math.round(m.avg_speed_mph)), "mph"),
        el({ width: 24 }),
        stat("Top speed", String(Math.round(m.max_speed_mph)), "mph"),
        el({ width: 24 }),
        stat("Attention score", String(Math.round(card.categories.attention)), "/100"),
      ),

      el(
        { flexDirection: "column", marginTop: 20 },
        row(small("Duration", fmtDuration(m.duration_s)), small("Distance", `${m.distance_mi.toFixed(1)} mi`), small("Over the limit", m.over_limit_s ? secs(m.over_limit_s) : "None")),
        row(
          small("Hard brakes + swerves", String(card.counts.hard_brakes + card.counts.swerves)),
          small("Phone use", m.phone_s ? secs(m.phone_s) : "None"),
          small("Warnings", String(warnings)),
        ),
      ),

      el(
        { flexDirection: "column", marginTop: 36, backgroundColor: C.panel, borderRadius: 28, padding: "32px 36px" },
        text("In brief", { fontSize: 28, fontWeight: 700 }),
        text(tripNarrative(card, meta.driverName), { marginTop: 12, fontSize: 30, lineHeight: 1.4, color: C.ink }),
      ),

      el({ flexDirection: "column", marginTop: 44 }, text("How you drove", { fontSize: 32, fontWeight: 700 }), ...CATEGORIES.map((c) => meter(LABELS[c], card.categories[c]))),
    ),
    el(
      { justifyContent: "space-between", alignItems: "center", borderTop: `2px solid ${C.line}`, paddingTop: 28 },
      text(facts.join("  ·  "), { fontSize: 26, color: C.ink2 }),
      text(`Peak risk ${Math.round(m.max_risk)}`, { fontSize: 26, color: C.muted }),
    ),
  );
}

export async function renderReportSvg(card: ReportCard, meta: ReportMeta): Promise<string> {
  return satori(reportTree(card, meta) as never, { width: W, height: H, fonts: loadFonts() });
}

/** PNG bytes of the report card. Throws if layout or rasterizing fails; callers fall back to text. */
export async function renderReportImage(card: ReportCard, meta: ReportMeta): Promise<Buffer> {
  const svg = await renderReportSvg(card, meta);
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng());
}
