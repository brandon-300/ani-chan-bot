# Audit repair status

Scope: `main`, whatsapp-web.js only. Finding IDs refer to the supplied
`anichan_full_codebase_audit_v2.md`. This is the first repair batch; the full
audit is not yet resolved.

## Implemented

| Findings | Changes |
| --- | --- |
| A01, A02, A04, A42 | Strict, bounded integer wagers; guarded atomic settlement of commands in `commands/gamble.js`; correct roulette net payouts; exact, safe shorthand amount parsing. |
| A05 | Fresh shared group/persona AI histories. DMs stay per user/persona. Old group records are neither imported nor rewritten; their pre-existing TTL rules still apply. |
| A06 | Generic queued reactions exclude `.gpt`. |
| A07 | Hourly news retained as requested; command reference and README corrected. |
| A08 | SFW requests use general ratings only; returned ratings, age/style tags, and missing safety metadata are checked. |
| A13, A14 | Owner/DM sticker-analysis help added; stale AI wording corrected; `.oppai` moved to NSFW help; README regenerated. |
| A16, A17 | Converter sticker author follows persona metadata; explicit `.take` overrides retained. Internal blacklist listener is excluded from command routing. |
| A20 | Dispatcher argument previews and feedback-content logs removed. This does not erase historical logs. |
| A26, A27 | Free claims require the current enabled, unexpired drop and conditionally consume it inside the card-grant transaction. |
| A33 | Self-donations rejected; donation debit, credit, and persistent message receipt commit together. Replays of the same donation message do not repeat payment. |
| A38 | Card Packs select three unowned catalogue cards, grant codes and first-owner fields, and consume one pack in a transaction. Shortage or failed grant rolls back the operation. |
| A39, A40 | Sale listing checks lending/ownership state atomically; shop purchases recheck state; loans recheck ownership and conditionally stake collateral inside the transaction. |
| A41 | User card/series searches escape regex operators and reject text over 100 characters. |

## Partially addressed

| Findings | Remaining work |
| --- | --- |
| A18 | Registration/session verification now stops command dispatch on unexpected errors. Shared cross-engine message deduplication behavior is unchanged. |
| A19 | User donations now use transactions and message receipts. Guild treasury transfers and guild locking still need repair. |
| A22 | Regression coverage added for economy, drops, ownership races, routing, and SFW filtering. Live integration and broader category coverage remain outstanding. |

## Pending

| Findings | Status |
| --- | --- |
| A03 | No real `.env` is tracked in the current repository. Archive/export protection and any credential rotation remain outstanding. No credentials were read, changed, or rotated in this batch. |
| A09, A10 | Playable multiplayer games requested. Proposed UNO/WCG rules await clarification. |
| A11, A12 | YouTube DASH merging and social albums are not included in this batch. |
| A15 | Durable recognition of `.gpt` replies after restart is not yet implemented. |
| A21 | Dependency cleanup deferred; no dependency or lockfile changes in this batch. |
| A23, A24 | Upload/media/AI providers still require live validation. |
| A25 | Lottery, `.db`, and `.dp` payout balancing awaits an explicit preserve/rebalance choice. Existing payouts remain. |
| A28–A32 | Complete auction lifecycle and financial safeguards await auction rule clarification. Existing auction handlers are not certified safe. |
| A34–A37 | Lucky Charm, orb redemption, stardust upgrades, and anticamp behavior await effect, price, and decay rules. |

## Validation and deployment limits

Tests use isolated models/adapters and injected failures, without pairing a
WhatsApp account or accessing production MongoDB. They cover application logic
and rollback handling; they do not certify live database indexes, transaction
support, or provider availability. Transactions require a MongoDB replica set
or sharded deployment, as already required by existing card/loan transactions.

Phone validation should include: an invalid negative wager, an invalid/expired
drop claim, a small donation between two different test users, and two group
members continuing the same persona conversation after a PM2 restart. Compare
private DM histories separately. Test Card Packs only with an available pack
and at least three unowned catalogue cards.
