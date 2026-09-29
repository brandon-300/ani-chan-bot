# Logging

The bot uses `utils/logger.js` as its single logging system. The default output is short, human-readable English for Termux and PM2:

```text
[16:38:05] [command] Received .ping from Brandon in DM (normal queue)
[16:38:05] [command] Executing .ping for Brandon in DM
[16:38:05] [command] Executed .ping OK (120ms)
[16:38:06] [queue] Heavy job .news started
[16:38:07] [sticker] Classified for Karane: laughing, teasing
[16:38:07] [error] Command .voice failed: network timeout
```

## Configuration

- `LOG_FORMAT=text` (default) prints readable English lines.
- `LOG_FORMAT=json` prints the existing one-line JSON records for ingestion by log tools.
- `LOG_LEVEL=ERROR|WARN|INFO|DEBUG` controls verbosity; the default is `INFO`.
- Routine empty heartbeat/daily-check ticks and Axios/fetch request start/end records are DEBUG-only. API failures remain visible at INFO/ERROR.
- Secrets, credentials, database URIs, query-string keys, full media/base64 payloads, and full sticker hashes are never printed in text logs.
- Sticker selection requires a classified analysis for the active persona: exact `reactions[]` matches are preferred, while non-exact matches must clear `AI_STICKER_MATCH_THRESHOLD` (default `18`). Otherwise the bot skips the sticker and logs `[sticker] Skipped (no good match for teasing)`.

## Event families

- `command.*` — command execution start/end, success/failure, unknown commands, and registration blocks
- `queue.*` — normal per-chat queue and heavy global queue lifecycle
- `route.*` — DM copilot, voice-note, group wake-word, menu, quiz answer, and sticker-import routing
- `background.*` — Mongo/WhatsApp startup, scheduler work, AI stickers, card drops, catalogue growth, AFK/mute/game restores, news broadcasts, and timers
- `scheduler.*` — task schedule, claim, handler execution, retry, stale-task recovery, and exhaustion
- `api.*` — safe external request outcome/status/duration and Cloudinary lifecycle
- `usage.*`, `message.*` — usage failures and ignored-message reasons

## Termux/PM2 test plan

1. Run `.ping`; expect timestamped `[command] Received .ping ...`, `[command] Executing .ping ...`, then `[command] Executed .ping OK (...)`.
2. Run `.news` or `.play`; expect `[queue] Heavy job ...` plus command start/end and any API failure lines.
3. Run an AI command; expect `[route] ...`, command start/end, and only API failures at INFO. Use `LOG_LEVEL=DEBUG` to see API start/end lines.
4. Run owner-only sticker import; expect `[sticker] Analyzing sticker ...` and `[sticker] Classified for ...` or a concise failure line.
5. Trigger an AI reaction with a classified exact match; expect `[sticker] Picked teasing → 12345678…`. Trigger one without a strong match; expect a skip and no sticker sent.
6. Reply with text to a bot-sent reaction sticker; the prompt must state that the bot sent the sticker and the user did not. Send a new user sticker separately; only that path uses the interpret-sticker instruction.
7. Restart under PM2; expect readable Mongo, WhatsApp, scheduler, and restore-job lifecycle lines with local-time prefixes.

```bash
pm2 logs ani-chan-bot --lines 200
LOG_FORMAT=json pm2 logs ani-chan-bot --raw
LOG_LEVEL=DEBUG pm2 logs ani-chan-bot --raw
```
