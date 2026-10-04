const util = require('util');

// One process-wide logger for PM2/Termux. JSON remains available with
// LOG_FORMAT=json; readable English is the default for humans in a terminal.
let sequence = 0;
const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const configuredLevel = String(process.env.LOG_LEVEL || 'INFO').trim().toUpperCase();
const LOG_LEVEL = Object.prototype.hasOwnProperty.call(LEVELS, configuredLevel) ? configuredLevel : 'INFO';
const configuredFormat = String(process.env.LOG_FORMAT || 'text').trim().toLowerCase();
const LOG_FORMAT = configuredFormat === 'json' ? 'json' : 'text';
const REDACT_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|uri|credential|private[_-]?key)/i;
const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 80;
const QUIET_INFO_EVENTS = /^(api\.request\.(start|end)|background\.(heartbeat|daily_stats_digest_check|inactive_user_sweep_check|guild_events_check|daily_news_broadcast_check)(\.start|\.end)?)$/;

function truncate(value, max = MAX_STRING_LENGTH) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

function shorten(value, max = 80) {
  const text = truncate(value, max);
  return text;
}

function shortenHash(value) {
  const text = String(value || '');
  return /^[a-f0-9]{16,}$/i.test(text) ? `${text.slice(0, 8)}…` : shorten(text, 80);
}

function redactUrl(value) {
  const raw = String(value || '');
  try {
    const parsed = new URL(raw);
    for (const key of [...parsed.searchParams.keys()]) {
      if (REDACT_KEY.test(key) || /^(key|sig|signature)$/i.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return truncate(parsed.toString().replace(/%5BREDACTED%5D/gi, '[REDACTED]'));
  } catch {
    return truncate(raw.replace(/([?&](?:token|secret|password|api[_-]?key|key|authorization|signature)=)[^&]*/gi, '$1[REDACTED]'));
  }
}

function safeValue(value, key = '', seen = new WeakSet()) {
  if (REDACT_KEY.test(key)) return '[REDACTED]';
  if (/url/i.test(key) && typeof value === 'string') return redactUrl(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message),
      code: value.code,
      stack: truncate(value.stack || '', 4000),
    };
  }
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY_ITEMS).map(item => safeValue(item, '', seen));
    if (value.length > MAX_ARRAY_ITEMS) result.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    return result;
  }

  const result = {};
  for (const childKey of Object.keys(value).slice(0, MAX_OBJECT_KEYS)) {
    result[childKey] = safeValue(value[childKey], childKey, seen);
  }
  if (Object.keys(value).length > MAX_OBJECT_KEYS) result._truncatedKeys = Object.keys(value).length - MAX_OBJECT_KEYS;
  return result;
}

function normalizeDetails(details) {
  if (details === undefined) return {};
  if (details && typeof details === 'object' && !Array.isArray(details) && !(details instanceof Error)) return safeValue(details);
  return { value: safeValue(details) };
}

function displayName(details) {
  return details.senderName || details.userName || details.personaDisplayName || details.personaId || details.senderId || 'user';
}

function commandName(details, event) {
  const name = details.command || event.split('.')[1] || 'command';
  return name.startsWith('.') ? name : `.${name}`;
}

function shortError(details) {
  const error = details.error;
  if (error && typeof error === 'object') return shorten(error.message || error.name || 'unknown error', 180);
  return shorten(error || details.reason || details.lastError || 'unknown error', 180);
}

function hostOf(value) {
  try { return new URL(String(value)).hostname; } catch { return null; }
}

// Readable one-liners for the AI reply pipeline. In text mode the logger only
// shows the event name unless a line is defined here, so every step of the AI's
// decision (what it was asked, what it offered, what Gemini chose, what was
// actually sent) has one, in the order it happens.
function quote(value, max = 90) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return `"${text.length > max ? `${text.slice(0, max - 1)}…` : text}"`;
}

function clockOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'later' : date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function aiLine(event, d) {
  switch (event) {
    case 'ai.input':
      return `[ai] Input from ${d.sender || 'user'} (${d.chat || 'chat'}) via .${d.command || 'ai'}${d.persona ? ` as ${d.persona}` : ''}: ${d.kind === 'sticker' ? 'sticker reply' : (d.kind || 'text')}${d.kind === 'text' ? ` ${quote(d.promptPreview)}` : ''} · ${d.historyTurns != null ? `${d.historyTurns} earlier messages · ` : ''}${d.stickersOffered || 0} stickers offered`;
    case 'ai.catalogue': {
      if (d.reason === 'stickers_disabled') return '[ai] Sticker catalogue: stickers are switched off (AI_STICKERS_ENABLED)';
      const ex = d.excluded || {};
      const skipped = [
        ex.recently_sent ? `${ex.recently_sent} recently sent` : '',
        ex.low_persona_fit ? `${ex.low_persona_fit} not fitting this character` : '',
        ex.unclassified ? `${ex.unclassified} not analysed yet` : '',
        ex.no_asset ? `${ex.no_asset} missing image` : '',
      ].filter(Boolean).join(', ');
      return `[ai] Sticker catalogue: offering ${d.offered || 0} of ${d.eligible || 0} usable stickers from ${d.animeCount || 0} anime (library ${d.library ?? '?'})${skipped ? ` · left out: ${skipped}` : ''}${d.reason && d.reason !== 'stickers_disabled' ? ` · ${String(d.reason).replace(/_/g, ' ')}` : ''}`;
    }
    case 'ai.model.reply': {
      const parts = [d.textChars ? `words ${quote(d.textPreview)}` : 'no words'];
      if (d.emoji) parts.push(`react ${d.emoji}`);
      if (d.sticker !== null && d.sticker !== undefined) parts.push(d.sticker === 'none' ? 'no sticker' : `sticker #${d.sticker}`);
      if (d.legacyReaction) parts.push(`(ignored old reaction label: ${d.legacyReaction})`);
      if (d.action) parts.push(`action ${d.action}`);
      return `[ai] Gemini chose: ${parts.join(' · ')}`;
    }
    case 'ai.sticker.choice':
      if (d.status === 'valid') return `[ai] Sticker #${d.requested} is on the catalogue: ${d.anime || 'unknown anime'}${d.description ? ` - ${d.description}` : ''}`;
      if (d.status === 'not_offered') return `[ai] Sticker #${d.requested} was NOT on the catalogue (${d.offered || 0} offered) - ignored, no sticker sent`;
      if (d.status === 'none_chosen') return `[ai] Gemini chose no sticker (${d.offered || 0} were offered)`;
      return `[ai] Gemini picked no sticker (${d.offered || 0} were offered)`;
    case 'ai.sticker.sent':
      return `[ai] Sent sticker #${d.id}: ${d.anime || 'unknown anime'}${d.description ? ` - ${d.description}` : ''} (${shortenHash(d.hash)})`;
    case 'ai.emoji.react':
      return `[ai] Reacted ${d.emoji} to the user's ${d.messageType === 'sticker' ? 'sticker' : 'message'}`;
    case 'ai.history.loaded':
      return `[ai] ${d.continuing ? `Continuing the conversation with ${d.personaId} (${d.messages} earlier message${d.messages === 1 ? '' : 's'})` : `No earlier conversation with ${d.personaId}: starting a new one`}${d.owner ? ' · owner: nothing expires' : ''}`;
    case 'ai.history.saved': {
      const when = d.expiresAt ? new Date(d.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      const expiry = d.owner
        ? 'owner: never expires'
        : `expires ${d.days} day${d.days === 1 ? '' : 's'} after the last message${d.scope === 'user' ? ' with any character' : ''} (${when})`;
      return `[ai] Saved to the ${d.personaId} conversation${d.kept != null ? ` (${d.kept} messages kept)` : ''} · ${expiry}${d.refreshed ? ` · extended ${d.refreshed} conversation(s)` : ''}`;
    }
    case 'ai.history.expired':
      return `[ai] The earlier conversation with ${d.personaId} had expired: starting fresh`;
    case 'ai.history.migrated':
      return `[ai] One-time update: ${d.moved} earlier conversation(s) are now the ${d.personaId} conversation (they were saved before each character had its own)`;
    case 'ai.history.indexes.synced':
      return '[ai] Conversation indexes are up to date: one conversation per chat, person and character';
    case 'ai.status_reaction.cleared':
      return "[ai] Removed the ⏳ from the user's message";
    case 'ai.status_reaction.clear_failed':
      return `[ai] Could not remove the ⏳: ${d.error || 'unknown error'}`;
    case 'ai.decision': {
      if (d.menu) return '[ai] Decision: sent the command menu';
      const did = [];
      if (d.text) did.push(`words (${d.textChars} chars)`);
      if (d.emoji) did.push(`reaction ${d.emoji}`);
      if (d.sticker) did.push(`sticker #${d.sticker.id} (${d.sticker.anime || 'unknown anime'})`);
      const aside = (d.dropped || []).length ? ` · set aside: ${d.dropped.join('; ')}` : '';
      return `[ai] Decision: ${did.join(' + ') || 'nothing sent'}${d.stickerReply ? ' · replying to a user sticker' : ''}${aside}`;
    }
    case 'ai.reaction.react':
      return `[ai] ${d.theirs} on my ${d.kind || 'message'} → I will react ${d.mine} in ${d.delayMs}ms`;
    case 'ai.reaction.skip':
      return `[ai] ${d.theirs} on my ${d.kind || 'message'}: not reacting back (${String(d.reason || '').replace(/_/g, ' ')})`;
    case 'gemini.gate.blocked':
      return `[ai] .${d.command || 'command'} paused while sticker analysis uses Gemini - told the user it is unavailable`;
    default:
      return null;
  }
}

function textLineBody(record) {
  const { event, level, ...details } = record;
  const errorEvent = level === 'ERROR' || /(^|\.)(failed|error|exhausted|crashed)$/.test(event);
  const tag = errorEvent ? 'error' : event.startsWith('command.') ? 'command'
    : event.startsWith('queue.') ? 'queue'
    : event.startsWith('route.') ? 'route'
    : event.includes('sticker') ? 'sticker'
    : event.startsWith('api.') ? 'api'
    : event.startsWith('background.') || event.startsWith('scheduler.') || event.startsWith('whatsapp.') ? 'background'
    : 'background';

  if (!errorEvent && (event.startsWith('ai.') || event === 'gemini.gate.blocked')) {
    const line = aiLine(event, details);
    if (line) return line;
  }

  if (errorEvent && event.startsWith('command.')) {
    return `[error] Command ${commandName(details, event)} failed: ${shortError(details)}`;
  }
  if (event.match(/^command\.[^.]+\.start$/)) {
    const where = details.chatLabel || (details.isGroup === false ? 'DM' : details.chatId || 'chat');
    return `[command] Executing ${commandName(details, event)} for ${displayName(details)} in ${shorten(where, 70)}`;
  }
  if (event.match(/^command\.[^.]+\.end$/)) {
    const status = details.status === 'success' ? 'OK' : `failed: ${shortError(details)}`;
    return `[command] Executed ${commandName(details, event)} ${status}${details.durationMs != null ? ` (${details.durationMs}ms)` : ''}`;
  }
  if (event === 'command.accepted') return `[command] Received ${commandName(details, event)} from ${displayName(details)} in ${shorten(details.chatLabel || (details.isGroup === false ? 'DM' : details.chatLabel || 'chat'), 70)} (${details.queue || 'normal'} queue)`;
  if (event === 'command.unknown') return `[command] Unknown ${commandName(details, event)}`;
  if (event === 'registration.blocked') return `[command] ${commandName(details, event)} blocked: registration required`;
  if (event.startsWith('command.')) return `[${tag}] ${commandName(details, event)} ${shortError(details)}`;

  if (event === 'queue.heavy.enqueued') return `[queue] Heavy job ${commandName(details, event)} queued${details.queuePosition ? ` (position ${details.queuePosition})` : ''}`;
  if (event === 'queue.heavy.job.start') return `[queue] Heavy job ${commandName(details, event)} started`;
  if (event === 'queue.heavy.job.end') return details.status === 'failed'
    ? `[error] Heavy job ${commandName(details, event)} failed: ${shortError(details)}${details.durationMs != null ? ` (${details.durationMs}ms)` : ''}`
    : `[queue] Heavy job ${commandName(details, event)} finished OK${details.durationMs != null ? ` (${details.durationMs}ms)` : ''}`;
  if (event === 'queue.heavy.worker.start') return `[queue] Heavy worker started (${details.queued || 0} waiting)`;
  if (event === 'queue.heavy.worker.idle') return '[queue] Heavy worker idle';
  if (event === 'queue.heavy.task.crashed') return `[queue] Heavy job failed: ${shortError(details)}`;
  if (event === 'queue.command.started') return `[queue] Command started after ${details.waitMs || 0}ms wait`;
  if (event === 'queue.command.finished') return `[queue] Command queue finished (${details.durationMs || 0}ms)`;
  if (event.startsWith('queue.')) return `[queue] ${event.slice(6).replace(/[._]/g, ' ')}`;

  if (event === 'background.ai_sticker_analysis.queued') return `[sticker] Queued analysis for ${details.personaId || 'persona'} (${details.queueLength || 0} waiting)`;
  if (event === 'background.ai_sticker_analysis.batch.start') return `[sticker] Analysing ${details.stickers || 0} sticker(s) for every character together (${details.tasks || 0} tasks, ${details.remaining || 0} still waiting)`;
  if (event === 'background.ai_sticker_analysis.batch.end') return details.status === 'failed'
    ? `[sticker] Analysis batch failed: ${shortError(details)}`
    : `[sticker] Batch ${details.status === 'partial' ? 'finished with problems' : 'done'}: ${details.analysed || 0} analysed${details.failed ? `, ${details.failed} failed` : ''} using ${details.requests ?? '?'} Gemini request(s)${details.durationMs != null ? ` (${details.durationMs}ms)` : ''}`;
  if (event === 'background.ai_sticker_analysis.overview') {
    const rows = Object.entries(details.personas || {}).map(([id, r]) => `${id} ${r.ready}/${details.library} ready${r.missing || r.failed ? ` (${r.missing} missing, ${r.failed} failed)` : ''}`).join(' · ');
    return `[sticker] Library: ${details.library ?? 0} stickers · ${rows || 'no personas'} · ${details.needing ? `${details.needing} need analysis` : 'nothing needs analysis'} · analysis is manual (.stickeranalyze)`;
  }
  if (event === 'background.ai_sticker_analysis.manual') return `[sticker] Owner started analysis (${details.mode}): ${details.stickers || 0} sticker(s) for ${(details.personas || []).join(', ')}, about ${details.requests ?? '?'} Gemini request(s)`;
  if (event === 'background.ai_sticker_analysis.cancelled') return `[sticker] Owner cancelled ${details.cancelled || 0} waiting analysis task(s)`;
  if (event === 'background.ai_sticker_analysis.auto_ignored') return '[sticker] AI_STICKER_AUTO_ANALYZE is ignored now: analysis is manual (send .stickeranalyze in your private DM)';
  if (event === 'background.ai_sticker_analysis.fit_failed') return `[sticker] Could not read Gemini's persona-fit reply for ${details.stickers || 0} sticker(s): ${shorten(details.error || '', 120)}`;
  if (event === 'background.ai_sticker_analysis.worker.start') return `[sticker] Analysis worker started (${details.queued || 0} queued)`;
  if (event === 'background.ai_sticker_analysis.worker.idle') return '[sticker] Analysis worker idle';
  if (event === 'background.ai_sticker_analysis.quota_hit') return `[sticker] Gemini quota error during sticker analysis - ${details.tasks || 'the'} task(s) stay queued: ${shorten(details.error || '', 120)}`;
  if (event === 'background.ai_sticker_analysis.quota_pause') return `[sticker] Gemini quota used up: sticker analysis paused for ${Math.round((details.cooldownMs || 0) / 60000) || '<1'} min (resumes about ${clockOf(details.resumeAt)}), ${details.remaining ?? '?'} waiting${details.streak > 1 ? `, ${details.streak} quota pauses in a row` : ''}`;
  if (event === 'background.ai_sticker_analysis.quota_resume') return `[sticker] Trying Gemini again: sticker analysis resumed (${details.queued || 0} waiting)`;
  if (event === 'background.ai_sticker.classified') return `[sticker] Classified for ${details.personaId || 'persona'}: ${(details.reactions || []).join(', ') || 'no reactions'}`;
  if (event === 'sticker.selection.picked') return `[sticker] Picked ${details.reaction || 'reaction'} → ${shortenHash(details.hash)}`;
  if (event === 'sticker.selection.skipped') return `[sticker] Skipped (no good match for ${details.reaction || 'reaction'})`;
  if (errorEvent && event.includes('ai_sticker')) return `[error] Sticker task failed: ${shortError(details)}`;
  if (event === 'background.ai_sticker_import_expiry.armed') return '[sticker] Import session expiry armed';
  if (event.includes('ai_sticker')) return `[sticker] ${event.split('.').slice(-1)[0].replace(/_/g, ' ')}`;

  if (event.startsWith('route.')) return `[route] ${event.slice(6).replace(/[._]/g, ' ')}${details.reason ? ` (${details.reason})` : ''}`;
  if (event === 'api.request.start') return `[api] ${details.method || 'GET'} ${hostOf(details.url) || 'request'} started`;
  if (event === 'api.request.end') return `[api] ${details.method || 'GET'} ${hostOf(details.url) || 'request'} ${details.ok ? 'OK' : 'failed'}${details.status ? ` (${details.status})` : ''}${details.durationMs != null ? ` in ${details.durationMs}ms` : ''}`;
  if (event.startsWith('api.')) return `[${tag}] ${event.slice(4).replace(/[._]/g, ' ')}${details.durationMs != null ? ` (${details.durationMs}ms)` : ''}`;
  if (event.startsWith('whatsapp.')) return `[background] WhatsApp ${event.slice(9).replace(/[._]/g, ' ')}`;
  if (event.startsWith('scheduler.')) return `[background] Scheduler ${event.slice(10).replace(/[._]/g, ' ')}`;
  if (event.match(/^background\.[^.]+\.start$/)) return `[background] ${event.slice(11, -6).replace(/[._]/g, ' ')} started`;
  if (event.match(/^background\.[^.]+\.end$/)) return `[background] ${event.slice(11, -4).replace(/[._]/g, ' ')} ${details.status === 'success' ? 'finished OK' : `failed: ${shortError(details)}`}${details.durationMs != null ? ` (${details.durationMs}ms)` : ''}`;
  if (event === 'message.ignored') return `[route] Ignored message: ${details.reason || 'not actionable'}`;
  if (errorEvent) return `[error] ${event.replace(/[._]/g, ' ')}: ${shortError(details)}`;
  return `[${tag}] ${event.replace(/[._]/g, ' ')}`;
}

function localTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour12: false });
}

function textLine(record) {
  return `[${localTime()}] ${textLineBody(record)}`;
}

function shouldDemote(level, event) {
  if (level === 'INFO' && QUIET_INFO_EVENTS.test(event)) return 'DEBUG';
  return level;
}

function write(level, event, details = {}) {
  const normalizedLevel = String(shouldDemote(String(level || 'INFO').toUpperCase(), event)).toUpperCase();
  if ((LEVELS[normalizedLevel] ?? LEVELS.INFO) > LEVELS[LOG_LEVEL]) return null;
  const record = {
    ts: new Date().toISOString(),
    seq: ++sequence,
    level: normalizedLevel,
    event,
    ...normalizeDetails(details),
  };
  const line = LOG_FORMAT === 'json' ? JSON.stringify(record) : textLine(record);
  if (normalizedLevel === 'ERROR') console.error(line);
  else if (normalizedLevel === 'WARN') console.warn(line);
  else console.log(line);
  return record;
}

function start(event, details = {}) {
  const startedAt = Date.now();
  const startRecord = write('INFO', `${event}.start`, details);
  let finished = false;
  return {
    sequence: startRecord?.seq || null,
    finish(status = 'success', extra = {}) {
      if (finished) return;
      finished = true;
      write(status === 'success' ? 'INFO' : 'ERROR', `${event}.end`, {
        ...details,
        ...extra,
        status,
        durationMs: Date.now() - startedAt,
        startSeq: startRecord?.seq || null,
      });
    },
  };
}

async function run(event, details, fn) {
  const operation = start(event, details);
  try {
    const result = await fn();
    operation.finish('success');
    return result;
  } catch (err) {
    operation.finish('failed', { error: safeValue(err) });
    throw err;
  }
}

function error(event, err, details = {}) {
  return write('ERROR', event, { ...details, error: safeValue(err) });
}

function debug(event, details = {}) {
  return write('DEBUG', event, details);
}

function getSequence() {
  return sequence;
}

module.exports = { write, start, run, error, debug, safeValue, redactUrl, getSequence, LOG_LEVEL, LOG_FORMAT, inspect: util.inspect };
