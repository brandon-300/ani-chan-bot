# Audit repair status

Scope: `main`, whatsapp-web.js only. Numbered findings below refer to the latest
uploaded **full static scan** (`Pasted text.txt`, 42 sections). Earlier audit IDs
are a separate list and are not interchangeable with these section numbers.

## Current repair batch

| Sections | Result |
| --- | --- |
| 1 | Real recent-message purge with role/capability checks and partial results; multiplayer UNO with private hands; persisted 30-second WCG votes; complete bank-escrow auction lifecycle. |
| 2 | Scheduler keeps polling after lookup errors, fences attempts by token, refreshes leases, prevents concurrent handlers for the same key, recovers interrupted attempts, and retries exhausted essential batches after a cooldown. |
| 3–5, 33 | Existing donation receipts and wager validation retained. Account reads update interest/activity with compare-and-set. Atomic changes and document saves share revisions, including safe handling of older documents without revisions. Currency bounds reject unsafe balances. Single-document shop, banking, lottery and pet saves reject stale writes. |
| 6–8 | Fusion and resell run in transactions with fresh ownership, tier/value and availability checks. Existing transactional Card Packs retained. Failed reward/payment writes roll back consumption. |
| 9 | Lucky Charm halves enabled group drop intervals for one hour without stacking; VIP updates the profile; Health Potion consumption and persisted battle HP change together. |
| 10 | Loan request, repayment and overdue seizure check ownership/staking and matched writes. Missing or changed collateral keeps the debt for review instead of clearing it or charging another owner's card. |
| 11–13, 39 | New challenge/season payout and completion commit together. Guild treasury and membership changes commit with account changes. Maintenance refreshes stale reads. Challenge proposals reserve guild participants with a unique partial index. Old interrupted payouts close without another award under the confirmed policy. |
| 14–16, 18–19 | Previously working read hooks, optional menu image, expiring offers, atomic activity tracking and connection routing retained. |
| 17 | The approved shared group/persona AI history and private DM histories are preserved. Old member histories are not merged. |
| 20–22, 41 | Game saves/deletes are awaited; actions/timers serialize by chat. Lobbies and absolute turn/question deadlines persist. Restore isolates malformed rows, pauses on persistence failure, and can recover after a failed startup lookup. Quiz questions are persisted before delivery and unsent saved questions can be republished. |
| 23–24 | Permanent guarded manual/automatic cleanup removes account-linked rows, releases owned cards, cancels uncommitted offers and clears live game/AFK state. Profile assets use a durable cleanup queue; replacements use unique IDs and register potential orphan uploads before contacting Cloudinary. Automatic inactivity threshold is **120 days**. |
| 25–26 | Existing fail-closed registration dispatch and shared adult-eligibility helper retained. |
| 27 | Chromium, bot identity and command-prefix consumers use the central configuration. Provider credentials remain in environment-backed provider boundaries; dynamic owner identity checks remain intact. |
| 28 | No real `.env` is tracked. Git export exclusions and a tracked-source ZIP utility omit credentials, authentication sessions, caches, logs and backups. This does not change earlier filesystem ZIPs or rotate credentials. |
| 29–30 | whatsapp-web.js is pinned to the patch's exact 1.34.7 version. Default Axios, fetch and media-download timeouts cover requests without an existing limit; explicit provider limits remain. Profile uploads and ffmpeg conversions also have timeouts. |
| 31–32, 35, 38 | Existing converters, AI/stickers, card core and interaction functionality retained; an undefined-variable failure in AniList's terminal error path was also removed. |
| 34 | Per-group hourly claims prevent competing broadcasts, successful groups keep their slots, failed groups retry on later minute ticks, and manual sends serialize with broadcasts. |
| 36 | Card drops select unowned candidates inside Mongo with indexed catalogue tiers instead of loading the full catalogue into phone RAM. Drop/lending task reconciliation repairs missing scheduling writes; stored drop timing prevents resending after a reschedule failure. |
| 37 | AFK state is persisted before acknowledgement and serialized per user; return clears use the recorded AFK timestamp. |
| 40 | Leadership can transfer to an existing member; the former leader becomes an officer. |
| 42 | Regression coverage now includes real local replica-set rollback/concurrency tests plus UNO, purge, scheduler polling, deadlines, exports and deleted-account claims. |

## Confirmed legacy payout policy

Old challenge/season records left in `resolving` are marked completed with
`closedWithoutPayment` and a closure timestamp. They receive no further coins,
reputation or season wins. Existing winner and payout flags are preserved.
Startup and periodic maintenance apply this policy automatically after deployment;
repeating closure does not repeat any award or season reset. If the interrupted
season is the latest one, closure starts its next season with fresh standings
in the same transaction. An already-existing newer season and its standings
are preserved.

## Boundaries

- WhatsApp sends and MongoDB commits cannot be atomic together. A crash after a
  send but before its acknowledgement is stored can duplicate a notice. Auction
  money/card settlement remains idempotent; failed notices do not repeat it.
- Purge counts revocation requests and eligibility failures. Actual deletion is
  enforced by WhatsApp, including its time/role rules.
- Shared group AI messages lack individual author keys, so deleting one account
  removes its DM/legacy member histories and retains shared group threads.
- Corrupt legacy loan collateral or balances at the safe integer limit require
  review; the bot retains obligations instead of inventing money or forgiving debt.
- Akinator was excluded from the supplied unfinished-feature assessment and was
  not rewritten. Other previously documented roadmap items, such as DASH video
  merging, social albums, orb redemption, stardust upgrades and anticamp policy,
  are not claimed to be completed by this batch.
- No phone, WhatsApp account, production database or paid provider was used for
  these checks. No credentials were read, changed or rotated.

## Validation

Unit tests: `node --test tests/*.test.js` (local Mongo integration test is skipped
without its explicit local test URI). Integration tests use a separate MongoDB 7
replica-set container and refuse remote/production URIs. They verify rollback,
concurrent transfers/bids, repeat settlement, activity/deletion guards, game
restoration, image cleanup, hourly claims and stale-write protection. All project
JavaScript also receives syntax checks and core source receives undefined-name,
unreachable-code and duplicate-key checks.

Latest validation: **186 unit tests and 30 real MongoDB regression scenarios passed**, including the 119/121-day cleanup boundary. All 165 JavaScript files passed syntax checks; core source passed the configured static checks.
