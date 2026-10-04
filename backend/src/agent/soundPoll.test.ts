import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SOUND, SOUNDS, SoundPoll, parseVote, pickWinner, pollText, resultText, type PollResult } from "./soundPoll.ts";

// Read from sounds.json, so the tests follow whatever sounds are configured.
const VS16 = String.fromCodePoint(0xfe0f); // emoji variation selector
const [A, B, C] = [SOUNDS[0]!, SOUNDS[1]!, SOUNDS[2]!];

/** Manual timers: `fire()` runs the pending callback, `cleared` counts clearTimeout calls. */
function fakeTimers() {
  const t = { pending: null as null | (() => void), cleared: 0 };
  return Object.assign(t, {
    timers: { set: (fn: () => void) => ((t.pending = fn), "timer"), clear: () => ((t.pending = null), t.cleared++) },
    fire: () => t.pending?.(),
  });
}

const drowsy = { tier: 2, dominant: "drowsy", sharingMode: "always" as const, roastActive: false };

test("parseVote takes numbers and emoji, nothing else", () => {
  assert.equal(parseVote("1"), A.id);
  assert.equal(parseVote(" 2 "), B.id);
  assert.equal(parseVote(C.emoji), C.id);
  for (const s of SOUNDS) {
    // With and without the U+FE0F variation selector that keyboards add or drop.
    const plain = s.emoji.replaceAll(VS16, "");
    assert.equal(parseVote(plain), s.id, `${s.title} plain`);
    assert.equal(parseVote(`${plain}${VS16}`), s.id, `${s.title} with FE0F`);
  }
  for (const t of [String(SOUNDS.length + 1), "12", "vote 1", A.id, ""]) assert.equal(parseVote(t), null, t);
});

test("one vote per contact: the latest replaces the earlier one", () => {
  const p = new SoundPoll({ timers: fakeTimers().timers });
  p.start(() => {});
  p.vote("mom", A.id);
  p.vote("sam", C.id);
  p.vote("mom", C.id);
  assert.equal(p.votes.size, 2);
  assert.equal(p.close()?.winner, C.id);
});

test("a tie picks at random among the tied, never another sound", () => {
  const votes = [A.id, C.id, B.id, C.id, A.id]; // A 2, C 2, B 1
  assert.equal(pickWinner(votes, () => 0).winner, A.id);
  assert.equal(pickWinner(votes, () => 0.99).winner, C.id);
  assert.equal(pickWinner(votes, () => 0.99).votes, 2);
});

test("no votes means the default sound", () => {
  const r = pickWinner([]);
  assert.deepEqual([r.winner, r.votes], [DEFAULT_SOUND, 0]);
  assert.match(resultText(r), /it is \(no votes\)\. Playing now\.$/);
});

test("closes when the timer fires and reports the result once", () => {
  const t = fakeTimers();
  const p = new SoundPoll({ timers: t.timers });
  const results: PollResult[] = [];
  p.start((r) => results.push(r));
  p.vote("mom", A.id);
  t.fire();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.winner, A.id);
  assert.equal(resultText(results[0]!), `${A.emoji} ${A.title} wins (1 vote). Playing now.`);
  assert.equal(p.isActive, false);
  assert.equal(p.close(), null);
});

test("cancel stops the timer and reports nothing", () => {
  const t = fakeTimers();
  const p = new SoundPoll({ timers: t.timers });
  let closed = false;
  p.start(() => (closed = true));
  p.vote("mom", C.id);
  p.cancel();
  assert.equal(t.cleared, 1);
  assert.equal(t.pending, null);
  assert.equal(p.isActive, false);
  assert.equal(p.vote("mom", C.id), false);
  assert.equal(closed, false);
});

test("an urgent (85) evaluation cancels an open poll", () => {
  const p = new SoundPoll({ timers: fakeTimers().timers });
  assert.equal(p.decide({ ...drowsy, tier: 3 }), null); // nothing open: nothing to cancel
  p.start(() => {});
  assert.equal(p.decide({ ...drowsy, tier: 3 }), "cancel");
  assert.equal(p.decide({ ...drowsy, tier: 3, dominant: "reckless" }), "cancel");
});

test("starts only for tier 1-2 drowsy, sharing on, no roast, no open poll, once per 5 min", () => {
  let now = 1_000_000;
  const p = new SoundPoll({ timers: fakeTimers().timers, now: () => now });
  assert.equal(p.decide({ ...drowsy, tier: 0 }), null);
  assert.equal(p.decide({ ...drowsy, dominant: "reckless" }), null);
  assert.equal(p.decide({ ...drowsy, sharingMode: "never" }), null);
  assert.equal(p.decide({ ...drowsy, roastActive: true }), null);
  assert.equal(p.decide({ ...drowsy, tier: 1 }), "start");
  p.start(() => {});
  assert.equal(p.decide(drowsy), null); // already open
  p.close();
  now += 4 * 60_000;
  assert.equal(p.decide(drowsy), null); // cooldown
  now += 60_000;
  assert.equal(p.decide(drowsy), "start");
});

test("allVoted and reactions to the poll message", () => {
  const p = new SoundPoll({ timers: fakeTimers().timers });
  p.start(() => {});
  p.addMessageId("m1");
  p.addMessageId(undefined);
  assert.equal(p.isPollMessage("m1"), true);
  assert.equal(p.isPollMessage("m2"), false);
  assert.equal(p.allVoted([]), false);
  p.vote("mom", C.id);
  assert.equal(p.allVoted(["mom", "sam"]), false);
  p.vote("sam", C.id);
  assert.equal(p.allVoted(["mom", "sam"]), true);
});

test("poll text lists every sound with its number", () => {
  const options = SOUNDS.map((s, i) => `${i + 1} ${s.emoji} ${s.title}`).join(" · ");
  assert.equal(pollText("Alex"), `😴 Alex is getting sleepy. Pick their wake-up sound (25s): reply ${options}`);
});
