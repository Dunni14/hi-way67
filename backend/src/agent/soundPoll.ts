// Wake-up sound poll: when the driver is getting drowsy (engine tier 1 or 2, before the 85 flow), the
// group chat votes on which bundled sound plays on the driver's phone. Votes are "1"/"2"/"3" or the
// sound's emoji, as a reply or (where the platform delivers reactions) a reaction to the poll message.
// Closes after 25 s or once every allowlisted contact has voted; the winner goes to the phone as
// `play_sound`. An urgent (tier 3) evaluation cancels the poll silently: the 85 flow and roast take over.
import { z } from "zod";
import type { SharingMode } from "../ws/protocol.ts";
import raw from "./sounds.json" with { type: "json" };

// The sounds live in sounds.json. `id` is the phone's res/raw/<id>.mp3 and the play_sound id (lowercase
// letters, digits, _), list order is the vote number (1..9), `default` plays when nobody votes.
const Sounds = z
  .object({
    default: z.string(),
    sounds: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]*$/), emoji: z.string().min(1), title: z.string().min(1) })).min(1).max(9),
  })
  .refine((c) => new Set(c.sounds.map((s) => s.id)).size === c.sounds.length, "sound ids must be unique")
  .refine((c) => new Set(c.sounds.map((s) => s.emoji)).size === c.sounds.length, "sound emoji must be unique")
  .refine((c) => c.sounds.some((s) => s.id === c.default), "default must be one of the sound ids");
const sounds = Sounds.parse(raw);

export const SOUNDS = sounds.sounds;
export type SoundId = string;
export const DEFAULT_SOUND: SoundId = sounds.default;
export const POLL_MS = 25_000;
export const COOLDOWN_MS = 5 * 60_000;
/** Engine tiers (0..3) that open a poll: nudge (40) and warning (70). Tier 3 (85) cancels it. */
export const POLL_TIERS = [1, 2];
export const ESCALATION_TIER = 3;

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Emoji keyboards add or drop the variation selector U+FE0F (🗣 vs 🗣️): compare without it. */
const VS16 = String.fromCodePoint(0xfe0f);
const bare = (t: string) => t.replaceAll(VS16, "");
const VOTE = new RegExp(`^\\s*(${[...SOUNDS.map((_, i) => String(i + 1)), ...SOUNDS.map((s) => escapeRe(bare(s.emoji)))].join("|")})\\s*$`, "u");

/** "1", " 🐐 " -> sound id; anything else -> null. */
export function parseVote(text: string): SoundId | null {
  const m = VOTE.exec(bare(text));
  if (!m) return null;
  const n = Number(m[1]);
  return (n >= 1 && n <= SOUNDS.length ? SOUNDS[n - 1] : SOUNDS.find((s) => bare(s.emoji) === m[1]))?.id ?? null;
}

export function soundInfo(id: SoundId) {
  return SOUNDS.find((s) => s.id === id)!;
}

export type PollResult = { winner: SoundId; votes: number; tally: Record<SoundId, number> };

/** Most votes wins; a tie is broken at random among the tied; no votes -> DEFAULT_SOUND. */
export function pickWinner(votes: Iterable<SoundId>, random = Math.random): PollResult {
  const tally: Record<SoundId, number> = Object.fromEntries(SOUNDS.map((s) => [s.id, 0]));
  for (const v of votes) if (v in tally) tally[v] = tally[v]! + 1;
  const top = Math.max(...Object.values(tally));
  if (top === 0) return { winner: DEFAULT_SOUND, votes: 0, tally };
  const tied = SOUNDS.map((s) => s.id).filter((id) => tally[id] === top);
  return { winner: tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))]!, votes: top, tally };
}

export type PollContext = { tier: number; dominant: string; sharingMode: SharingMode; roastActive: boolean };

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as NodeJS.Timeout) };

export class SoundPoll {
  private startedAt = 0;
  private lastStartedAt = -Infinity;
  private timer: unknown = null;
  private onClose: ((r: PollResult) => void) | null = null;
  private readonly messageIds = new Set<string>();
  readonly votes = new Map<string, SoundId>(); // contact handle -> latest choice

  constructor(
    private readonly opts: { durationMs?: number; cooldownMs?: number; random?: () => number; now?: () => number; timers?: Timers } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  get isActive() {
    return this.startedAt > 0;
  }

  /** What an engine evaluation means for the poll: open one, cancel the open one, or nothing. */
  decide(ctx: PollContext): "start" | "cancel" | null {
    if (ctx.tier >= ESCALATION_TIER) return this.isActive ? "cancel" : null;
    if (!POLL_TIERS.includes(ctx.tier) || ctx.dominant !== "drowsy") return null;
    if (ctx.sharingMode === "never" || ctx.roastActive || this.isActive) return null;
    if (this.now() - this.lastStartedAt < (this.opts.cooldownMs ?? COOLDOWN_MS)) return null;
    return "start";
  }

  /** Open the poll; `onClose` gets the result when it closes (timer or everyone voted), never on cancel. */
  start(onClose: (r: PollResult) => void) {
    this.cancel();
    this.startedAt = this.lastStartedAt = this.now();
    this.onClose = onClose;
    this.timer = (this.opts.timers ?? realTimers).set(() => this.close(), this.opts.durationMs ?? POLL_MS);
  }

  /** Remember the id of a poll message sent to a chat, so reactions to it count as votes. */
  addMessageId(id: string | undefined) {
    if (id) this.messageIds.add(id);
  }

  isPollMessage(id: string | undefined) {
    return !!id && this.messageIds.has(id);
  }

  /** One vote per contact; a later vote replaces the earlier one. False when no poll is open. */
  vote(handle: string, choice: SoundId) {
    if (!this.isActive) return false;
    this.votes.set(handle, choice);
    return true;
  }

  /** Every given handle has voted (an empty list never counts as everyone). */
  allVoted(handles: string[]) {
    return handles.length > 0 && handles.every((h) => this.votes.has(h));
  }

  /** Close now and report the winner. Null if no poll was open. */
  close(): PollResult | null {
    if (!this.isActive) return null;
    const result = pickWinner(this.votes.values(), this.opts.random);
    const onClose = this.onClose;
    this.reset();
    onClose?.(result);
    return result;
  }

  /** Drop the open poll without a result (escalation, trip end). */
  cancel() {
    this.reset();
  }

  private reset() {
    if (this.timer !== null) (this.opts.timers ?? realTimers).clear(this.timer);
    this.timer = null;
    this.startedAt = 0;
    this.onClose = null;
    this.votes.clear();
    this.messageIds.clear();
  }
}

/** "😴 Alex is getting sleepy. Pick their wake-up sound (25s): reply 1 🐓 Rooster · 2 📯 Air horn · 3 🐐 Goat scream" */
export function pollText(driver: string, durationMs = POLL_MS) {
  const options = SOUNDS.map((s, i) => `${i + 1} ${s.emoji} ${s.title}`).join(" · ");
  return `😴 ${driver} is getting sleepy. Pick their wake-up sound (${Math.round(durationMs / 1000)}s): reply ${options}`;
}

/** "🐓 Rooster wins (2 votes). Playing now." */
export function resultText(r: PollResult) {
  const s = soundInfo(r.winner);
  if (r.votes === 0) return `${s.emoji} ${s.title} it is (no votes). Playing now.`;
  return `${s.emoji} ${s.title} wins (${r.votes} vote${r.votes === 1 ? "" : "s"}). Playing now.`;
}

export const soundPoll = new SoundPoll();
