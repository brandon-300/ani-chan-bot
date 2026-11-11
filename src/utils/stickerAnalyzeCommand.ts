/**
 * Manual sticker analysis (.stickeranalyze).
 * Factory attaches to aiStickers internals so the migration branch can land
 * this as a small new file + tiny wiring change.
 */
import { listPersonaIds, loadPersona } from './persona.js';
import logger from './logger.js';
import { AI_STICKER_ANALYSIS_VERSION, AI_STICKER_AUTO_ANALYZE } from './config.js';

export function attachAnalyzeCommand(deps) {
  const {
    getPersonaAnalysis,
    loadSharedStickers,
    enqueueAnalysis,
    analysisKey,
    queuedAnalysis,
    analysisQueue,
    runAnalysisQueue,
    getAnalysisRuntime,
    verifyOwnerPrivateChat,
    unavailableStorageMessage,
    personaVersion,
  } = deps;

  function isUsableAnalysis(analysis) {
    return Boolean(analysis) && analysis.analysisStatus === 'classified';
  }

  function hasDescription(doc) {
    const generic = doc?.genericAnalysis;
    return Boolean(generic && (String(generic.expression || '').trim() || (Array.isArray(generic.reactions) && generic.reactions.length)));
  }

  function personaIdsNeedingAnalysis(record, personaIds) {
    return personaIds.filter(personaId => !isUsableAnalysis(getPersonaAnalysis(record, personaId)));
  }

  function summarizeLibrary(records, personaIds) {
    const personas = {};
    for (const personaId of personaIds) {
      const row = { ready: 0, missing: 0, failed: 0, outdated: 0 };
      for (const record of records) {
        const analysis = getPersonaAnalysis(record, personaId);
        if (!analysis) row.missing += 1;
        else if (!isUsableAnalysis(analysis)) row.failed += 1;
        else {
          row.ready += 1;
          if (Number(analysis.analysisVersion || 1) !== AI_STICKER_ANALYSIS_VERSION) row.outdated += 1;
        }
      }
      personas[personaId] = row;
    }
    return {
      library: records.length,
      undescribed: records.filter(record => !hasDescription(record)).length,
      personas,
    };
  }

  function estimateRequests(records, personaIds, mode) {
    let stickers = 0;
    let requests = 0;
    for (const record of records) {
      const needing = mode === 'redo' ? personaIds : personaIdsNeedingAnalysis(record, personaIds);
      if (needing.length) {
        stickers += 1;
        requests += needing.length;
      }
    }
    return { stickers, requests };
  }

  function queueStateText() {
    const rt = getAnalysisRuntime();
    if (rt.quotaResumeTimer) return `paused for quota (resumes ~${new Date(rt.quotaResumeAt).toISOString()})`;
    if (rt.analysisBusy) return `running (${analysisQueue.length} waiting)`;
    if (analysisQueue.length) return `queued (${analysisQueue.length})`;
    return 'idle';
  }

  function cancelQueuedAnalysis() {
    const cancelled = analysisQueue.length;
    for (const task of analysisQueue) {
      queuedAnalysis.delete(analysisKey(task.personaId, task.hash));
    }
    analysisQueue.length = 0;
    return cancelled;
  }

  async function queueManualAnalysis({ mode, personaIds }) {
    const records = await loadSharedStickers({ force: true });
    const stickers = new Set();
    let tasks = 0;
    for (const record of records) {
      const targets = mode === 'redo' ? personaIds : personaIdsNeedingAnalysis(record, personaIds);
      for (const personaId of targets) {
        if (mode === 'redo') {
          const key = analysisKey(personaId, record.hash);
          if (!queuedAnalysis.has(key)) {
            queuedAnalysis.add(key);
            analysisQueue.push({ personaId, hash: record.hash });
          }
        } else {
          enqueueAnalysis(personaId, record.hash);
        }
        tasks += 1;
        stickers.add(record.hash);
      }
    }
    if (tasks) setImmediate(runAnalysisQueue);
    return { stickers: stickers.size, tasks };
  }

  const ANALYZE_USAGE = [
    'Usage: .stickeranalyze [status|new|redo|stop] [persona|all] [confirm]',
    '• status — library summary (default, spends nothing)',
    '• new — analyse stickers that still lack a working analysis',
    '• redo — re-analyse everything (needs confirm)',
    '• stop — cancel waiting queue tasks',
    'Owner only, private DM. Nothing is analysed automatically at startup.',
  ].join('\n');

  async function analyzeCommand(client, msg, args) {
    const verified = await verifyOwnerPrivateChat(msg);
    if (!verified) {
      await msg.reply('❌ Sticker analysis is available only to the bot owner in a private DM.');
      return false;
    }
    const words = (args || []).map(word => String(word).toLowerCase());
    const known = ['status', 'new', 'redo', 'stop'];
    const action = words.length === 0 ? 'status' : known.includes(words[0]) ? words[0] : null;
    const confirmed = words.includes('confirm');
    const rest = words.slice(1).filter(word => word !== 'confirm');
    if (!action || rest.length > 1) {
      await msg.reply(ANALYZE_USAGE);
      return false;
    }
    const allIds = listPersonaIds();
    let personaIds = allIds;
    if (rest[0] && rest[0] !== 'all') {
      if (!allIds.includes(rest[0])) {
        await msg.reply(`❌ Unknown persona "${rest[0]}". Available: ${allIds.join(', ')}.`);
        return false;
      }
      personaIds = [rest[0]];
    }

    if (action === 'stop') {
      const cancelled = cancelQueuedAnalysis();
      await msg.reply(cancelled
        ? `🛑 Cancelled ${cancelled} waiting analysis task(s). A request already in progress will finish.`
        : 'Nothing was waiting.');
      return true;
    }

    let records;
    try {
      records = await loadSharedStickers({ force: true });
    } catch (err) {
      await msg.reply(`❌ Could not read the sticker library: ${unavailableStorageMessage(err)}`);
      return false;
    }

    if (action === 'status') {
      const summary = summarizeLibrary(records, personaIds);
      const fresh = estimateRequests(records, personaIds, 'new');
      const everything = estimateRequests(records, personaIds, 'redo');
      const lines = [
        '🎴 *Sticker analysis*',
        `Library: ${summary.library} stickers (${summary.undescribed} without a description yet)`,
      ];
      for (const personaId of personaIds) {
        const row = summary.personas[personaId];
        lines.push(
          `• ${personaId}: ${row.ready} ready, ${row.missing} not analysed, ${row.failed} failed`
          + (row.outdated ? `, ${row.outdated} from an older analysis version` : ''),
        );
      }
      lines.push(`Queue: ${queueStateText()}`, '');
      lines.push(fresh.stickers
        ? `*new* would analyse ${fresh.stickers} sticker(s): about ${fresh.requests} request(s).`
        : 'Nothing needs analysing.');
      lines.push(`*redo* would redo all ${everything.stickers}: about ${everything.requests} request(s).`);
      lines.push('', 'Nothing is analysed automatically, not at startup and not after an update.');
      await msg.reply(lines.join('\n'));
      return true;
    }

    const estimate = estimateRequests(records, personaIds, action);
    if (!confirmed) {
      await msg.reply(
        `About to run *${action}* for ${personaIds.join(', ')}:\n`
        + `• ${estimate.stickers} sticker(s)\n`
        + `• ~${estimate.requests} Gemini request(s)\n\n`
        + `Reply \`.stickeranalyze ${action}${rest[0] ? ' ' + rest[0] : ''} confirm\` to start.`,
      );
      return false;
    }
    if (action === 'new' && estimate.stickers === 0) {
      await msg.reply('✅ Every sticker already has a working analysis. Nothing to do.');
      return true;
    }
    const result = await queueManualAnalysis({ mode: action, personaIds });
    await msg.reply(
      `✅ Analysing ${result.stickers} sticker(s) for ${personaIds.join(', ')}: `
      + `about ${estimate.requests} Gemini request(s), done in a few minutes. `
      + 'Gemini commands are unavailable until it finishes; progress is in the logs. '
      + 'Send .stickeranalyze to check.',
    );
    return true;
  }

  return { analyzeCommand, summarizeLibrary, estimateRequests, isUsableAnalysis };
}
