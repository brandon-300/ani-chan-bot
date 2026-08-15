const { AsyncLocalStorage } = require('async_hooks');
const CommandUsage = require('../models/CommandUsage');

// Tracks "which command is currently executing" across async boundaries
// (including inside whatever axios/fetch calls that command's handler
// makes), without threading a context argument through every command
// file. Node's own recommended tool for exactly this — request-scoped
// context that survives awaits/promises/callbacks.
const als = new AsyncLocalStorage();

function runWithCommandContext(context, fn) {
  return als.run(context, fn);
}

function getCurrentContext() {
  return als.getStore() || null;
}

// Called once per command invocation, right as it starts. Fire-and-forget
// on purpose (see wrapWithUsageTracking) — this must never add latency to
// the actual command reply, and a tracking failure must never break it.
async function recordCommandUsage(groupId, userId, command) {
  await CommandUsage.findOneAndUpdate(
    { groupId, userId, command },
    { $inc: { count: 1 }, $set: { lastUsed: new Date() } },
    { upsert: true }
  );
}

// Bumps apiCallCount for whichever command is currently executing, per the
// AsyncLocalStorage context set by runWithCommandContext. Also
// fire-and-forget for the same latency/safety reason — this runs inside an
// axios/fetch interceptor, so throwing here would break the real request.
function recordApiCall() {
  const ctx = getCurrentContext();
  if (!ctx) return; // no command context active (e.g. a background job) — nothing to attribute this to
  CommandUsage.findOneAndUpdate(
    { groupId: ctx.groupId, userId: ctx.userId, command: ctx.command },
    { $inc: { apiCallCount: 1 } },
    { upsert: true }
  ).catch(err => console.error('[usageTracking] recordApiCall failed:', err.message));
}

// Installs interceptors once at startup (see index.js) so every outbound
// HTTP call anywhere in the bot is counted automatically — nobody needs to
// remember to instrument a new downloader/API integration by hand. Every
// command file does `require('axios')` without axios.create(), so they all
// share this same default instance; global.fetch is Node's own built-in
// (confirmed nothing in this codebase uses the separate node-fetch package),
// so patching it here covers every bare fetch(...) call too.
let instrumented = false;
function instrumentHttpClients() {
  if (instrumented) return;
  instrumented = true;

  const axios = require('axios');
  axios.interceptors.request.use(config => {
    recordApiCall();
    return config;
  });

  const originalFetch = global.fetch;
  if (typeof originalFetch === 'function') {
    global.fetch = function patchedFetch(...args) {
      recordApiCall();
      return originalFetch.apply(this, args);
    };
  }
}

// Wraps a resolved command handler so calling it (a) records the
// invocation and (b) opens the AsyncLocalStorage context for the duration
// of its execution, so any HTTP calls it makes get attributed correctly.
// index.js's dispatcher swaps `handlerFn` for the result of this at both
// of its two call sites (normal path + heavy-queue path) — see the
// "Usage tracking context" comment there.
function wrapWithUsageTracking(handlerFn, context) {
  return async () => {
    recordCommandUsage(context.groupId, context.userId, context.command).catch(err =>
      console.error('[usageTracking] recordCommandUsage failed:', err.message)
    );
    return runWithCommandContext(context, handlerFn);
  };
}

module.exports = {
  runWithCommandContext,
  getCurrentContext,
  recordCommandUsage,
  recordApiCall,
  instrumentHttpClients,
  wrapWithUsageTracking,
};
