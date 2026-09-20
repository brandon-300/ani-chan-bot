// ─── Per-guild mutation lock ────────────────────────────────────────────────
// Serializes every mutation to the SAME guild through one promise chain, so
// two commands touching that guild at (nearly) the same instant can never
// interleave their load-modify-save cycles and silently clobber one
// another's changes. This is the fix for the reliability audit's "guild
// mutation concurrency" item: donate, quests, missions, treasury, upgrades,
// reputation, applications, membership, and challenges all follow a
// load-then-modify-then-save pattern in commands/guilds.js (and
// Guild.addQuestProgress in models/Guild.js, called from card claims and
// game wins across the whole bot) — without this, two of those racing for
// the same guild can both read the same stale version and one save
// overwrites the other's.
//
// Purely in-process (a plain Map, not a Mongo-backed lock) — sufficient
// because AniChan runs as a single PM2 instance (see reliability item #33:
// never run this bot with `pm2 -i max` / cluster mode). A second process
// would not see or respect these locks at all; if that ever changes, this
// would need to become a real distributed lock instead.
//
// Different guilds never block each other — the queue is keyed per
// guildId, not global — so a lock held for guild A has no effect on a
// concurrent command touching guild B.
//
// UNCERTAIN / known limitation: there's no timeout here. If `fn` hangs
// forever (an unresponsive Mongo call, say), every subsequent mutation to
// that SAME guild queues up behind it indefinitely — other guilds are
// unaffected. Every guild mutation already goes through Mongo/WhatsApp
// calls that don't have explicit timeouts anywhere else in this codebase
// either (that's reliability item #63, not yet done), so this doesn't
// introduce a new class of risk, just doesn't fix an existing one. Worth
// revisiting once #63 adds timeouts generally.
const queues = new Map();

// Runs `fn` once this guild's current queue has drained, and returns
// whatever `fn` returns (or throws whatever `fn` throws) to the caller.
// Callers should do their ENTIRE load-modify-save cycle for this guild
// inside `fn` — locking just the final .save() call isn't enough, since
// the race is "two commands both read the same stale version before
// either writes," not just "two saves landing at once."
function withGuildLock(guildId, fn) {
  const key = String(guildId);
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  // The tail stored for the NEXT caller to chain onto must never itself be
  // a rejected promise — a guild whose mutation once failed shouldn't wedge
  // every future mutation to that same guild. This swallowed-error tail is
  // only ever used internally as a scheduling gate; it's never handed back
  // to any caller, so nobody's real success or failure gets swallowed by
  // it. Each caller's OWN `run` above still resolves or rejects with
  // exactly what `fn` did.
  queues.set(key, run.then(() => {}, () => {}));
  return run;
}

module.exports = { withGuildLock };
