// Raw 1 Hz signals → normalized feature vector (README §1 implementation notes):
//  - 60 s baseline per trip; everything is scored as deviation from it
//  - 10 s rolling average on every signal so a blink never triggers an alert
//  - when Presage loses the face, signals are `missing`, not zero
import { clamp } from "./linalg.ts";
import { emptyFeatures, norm, PRESAGE_FEATURES, type FeatureMap, type FeatureName } from "./features.ts";

/** One second of input. Presage fields are omitted when the face is lost. */
export type Sample = {
  ts: number; // epoch ms
  hr?: number; // bpm
  breathing?: number; // breaths / min
  engagement?: number; // 0..1, 1 = fully focused
  eyeClosure?: number; // 0..1 fraction of the last second the eyes were closed
  stress?: number; // 0..1 anger / stress expression
  yawn?: boolean;
  nod?: boolean;
  gazeOff?: boolean; // looking away from the road this second
  speed?: number; // mph
  speedLimit?: number; // mph
  hardBrake?: boolean;
  swerve?: boolean;
};

export const BASELINE_MS = 60_000;
export const SMOOTH_N = 10;
const MIN_BASELINE_SAMPLES = 20;
const PRESAGE_KEYS = ["hr", "breathing", "engagement", "eyeClosure", "stress"] as const;
type PresageKey = (typeof PRESAGE_KEYS)[number];

/** Rolling mean over the last N *present* values; undefined when none. */
export class RollingMean {
  private buf: number[] = [];
  constructor(private n = SMOOTH_N) {}
  push(v: number | undefined) {
    this.buf.push(v ?? NaN);
    if (this.buf.length > this.n) this.buf.shift();
  }
  get value(): number | undefined {
    const ok = this.buf.filter((v) => !Number.isNaN(v));
    // Need at least half the window present, otherwise treat as missing.
    return ok.length >= Math.ceil(this.n / 2) ? ok.reduce((s, v) => s + v, 0) / ok.length : undefined;
  }
}

type Baseline = Partial<Record<"hr" | "breathing" | "engagement", number>>;

export type FeatureResult = {
  features: FeatureMap;
  /** Presage features that could be computed this window (others are 0 and excluded from scoring). */
  available: Set<FeatureName>;
  faceVisible: boolean;
  calibrating: boolean;
};

export class SignalProcessor {
  private startTs: number | null = null;
  private sums: Record<"hr" | "breathing" | "engagement", { s: number; n: number }> = {
    hr: { s: 0, n: 0 },
    breathing: { s: 0, n: 0 },
    engagement: { s: 0, n: 0 },
  };
  baseline: Baseline = {};
  private baselineDone = false;
  private roll = Object.fromEntries(PRESAGE_KEYS.map((k) => [k, new RollingMean()])) as Record<PresageKey, RollingMean>;
  private speed = new RollingMean();
  private gazeOff = new RollingMean();
  // Per-window event counters, reset by `takeWindow`.
  private yawns = 0;
  private nods = 0;
  private brakes = 0;
  private swerves = 0;
  private lastSpeedLimit = 65;

  get calibrating() {
    return !this.baselineDone;
  }

  push(s: Sample) {
    this.startTs ??= s.ts;
    for (const k of PRESAGE_KEYS) this.roll[k].push(s[k]);
    this.speed.push(s.speed);
    this.gazeOff.push(s.gazeOff === undefined ? undefined : s.gazeOff ? 1 : 0);
    if (s.speedLimit) this.lastSpeedLimit = s.speedLimit;
    if (s.yawn) this.yawns++;
    if (s.nod) this.nods++;
    if (s.hardBrake) this.brakes++;
    if (s.swerve) this.swerves++;

    if (!this.baselineDone) {
      for (const k of ["hr", "breathing", "engagement"] as const) {
        const v = s[k];
        if (v !== undefined) {
          this.sums[k].s += v;
          this.sums[k].n++;
        }
      }
      if (s.ts - this.startTs >= BASELINE_MS) this.finishBaseline();
    }
  }

  private finishBaseline() {
    // Not enough face time: keep collecting rather than lock in a junk baseline.
    if (this.sums.hr.n < MIN_BASELINE_SAMPLES) return;
    for (const k of ["hr", "breathing", "engagement"] as const) {
      if (this.sums[k].n >= MIN_BASELINE_SAMPLES) this.baseline[k] = this.sums[k].s / this.sums[k].n;
    }
    this.baselineDone = true;
  }

  /** Features for the window that just ended; resets the event counters. */
  takeWindow(ts: number, hoursDriving: number): FeatureResult {
    const f = emptyFeatures();
    const available = new Set<FeatureName>();
    const hr = this.roll.hr.value;
    const br = this.roll.breathing.value;
    const eng = this.roll.engagement.value;
    const closure = this.roll.eyeClosure.value;
    const stress = this.roll.stress.value;
    const faceVisible = closure !== undefined || hr !== undefined || eng !== undefined;
    const b = this.baseline;

    if (this.baselineDone) {
      if (br !== undefined && b.breathing) {
        f.breathing_drop = norm.rel(Math.max(0, b.breathing - br), b.breathing, 0.4);
        available.add("breathing_drop");
      }
      if (hr !== undefined && b.hr) {
        f.hr_drop = norm.rel(Math.max(0, b.hr - hr), b.hr, 0.25);
        f.hr_spike = norm.rel(Math.max(0, hr - b.hr), b.hr, 0.3);
        available.add("hr_drop").add("hr_spike");
      }
      if (eng !== undefined && b.engagement) {
        f.engagement_loss = norm.rel(Math.max(0, b.engagement - eng), b.engagement, 0.8);
        available.add("engagement_loss");
      }
    }
    // These two need no baseline: absolute eye closure and expression are meaningful.
    if (closure !== undefined || this.yawns || this.nods) {
      f.eye_closure = clamp((closure ?? 0) / 0.3 + 0.25 * (this.yawns + this.nods), 0, 1);
      available.add("eye_closure");
    }
    if (stress !== undefined) {
      f.emotion_stress = clamp(stress, 0, 1);
      available.add("emotion_stress");
    }
    // Looking away is distraction, not drowsiness: fold it into engagement loss.
    const away = this.gazeOff.value;
    if (away !== undefined && away > 0) {
      f.engagement_loss = Math.max(f.engagement_loss, clamp(away / 0.4, 0, 1));
      available.add("engagement_loss");
    }

    // Phone sensors are always available.
    f.hard_brake_count = norm.hardBrakes(this.brakes);
    f.swerve_count = norm.swerves(this.swerves);
    f.speed_over_limit = norm.speedOver(this.speed.value ?? 0, this.lastSpeedLimit);
    f.hours_driving = norm.hours(hoursDriving);
    f.night_time = norm.night(new Date(ts));

    this.yawns = this.nods = this.brakes = this.swerves = 0;
    return { features: f, available, faceVisible, calibrating: !this.baselineDone };
  }
}

export const isPresageFeature = (k: FeatureName) => PRESAGE_FEATURES.includes(k);
