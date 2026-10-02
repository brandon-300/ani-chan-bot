
// Tracks "which command is currently executing" across async boundaries.
import CommandUsage from '../models/CommandUsage.js';
import axios from 'axios';
import logger from './logger.js';
import { AsyncLocalStorage } from 'async_hooks';
const als = new AsyncLocalStorage();

function runWithCommandContext(context, fn) {
  return als.run(context, fn);
}

function getCurrentContext() {
  return als.getStore() || null;
}

async function recordCommandUsage(groupId, userId, command) {
  await CommandUsage.findOneAndUpdate(
    { groupId, userId, command },
    { $inc: { count: 1 }, $set: { lastUsed: new Date() } },
    { upsert: true }
  );
}

function recordApiCall() {
  const ctx = getCurrentContext();
  if (!ctx) return;
  CommandUsage.findOneAndUpdate(
    { groupId: ctx.groupId, userId: ctx.userId, command: ctx.command },
    { $inc: { apiCallCount: 1 } },
    { upsert: true }
  ).catch(err => logger.error('usage.api_call_count.failed', err, { command: ctx.command }));
}

function requestContext(protocol, method, url, details = {}) {
  return {
    protocol,
    method: String(method || 'GET').toUpperCase(),
    url: logger.redactUrl(url),
    ...details,
  };
}

let instrumented = false;
function instrumentHttpClients() {
  if (instrumented) return;
  instrumented = true;

  axios.interceptors.request.use(config => {
    const startedAt = Date.now();
    config.__loggerStartedAt = startedAt;
    const url = `${config.baseURL || ''}${config.url || ''}`;
    const ctx = getCurrentContext();
    logger.write('INFO', 'api.request.start', requestContext('axios', config.method, url, {
      command: ctx?.command || null,
      responseType: config.responseType || null,
    }));
    recordApiCall();
    return config;
  }, err => {
    logger.error('api.request.prepare_failed', err, { protocol: 'axios' });
    return Promise.reject(err);
  });

  axios.interceptors.response.use(response => {
    const config = response.config || {};
    const url = `${config.baseURL || ''}${config.url || ''}`;
    const ctx = getCurrentContext();
    logger.write('INFO', 'api.request.end', requestContext('axios', config.method, url, {
      command: ctx?.command || null,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      durationMs: Date.now() - (config.__loggerStartedAt || Date.now()),
    }));
    return response;
  }, err => {
    const config = err.config || {};
    const url = `${config.baseURL || ''}${config.url || ''}`;
    const ctx = getCurrentContext();
    logger.error('api.request.failed', err, requestContext('axios', config.method, url, {
      command: ctx?.command || null,
      status: err.response?.status || null,
      durationMs: Date.now() - (config.__loggerStartedAt || Date.now()),
    }));
    return Promise.reject(err);
  });

  const originalFetch = global.fetch;
  if (typeof originalFetch === 'function') {
    global.fetch = function patchedFetch(input, init = {}) {
      const url = typeof input === 'string' ? input : input?.url;
      const method = init.method || input?.method || 'GET';
      const startedAt = Date.now();
      const ctx = getCurrentContext();
      logger.write('INFO', 'api.request.start', requestContext('fetch', method, url, { command: ctx?.command || null }));
      recordApiCall();
      return originalFetch.apply(this, arguments).then(response => {
        logger.write('INFO', 'api.request.end', requestContext('fetch', method, url, {
          command: ctx?.command || null,
          status: response.status,
          ok: response.ok,
          durationMs: Date.now() - startedAt,
        }));
        return response;
      }).catch(err => {
        logger.error('api.request.failed', err, requestContext('fetch', method, url, {
          command: ctx?.command || null,
          durationMs: Date.now() - startedAt,
        }));
        throw err;
      });
    };
  }
}

function wrapWithUsageTracking(handlerFn, context) {
  return async () => {
    recordCommandUsage(context.groupId, context.userId, context.command).catch(err =>
      logger.error('usage.command_count.failed', err, { command: context.command })
    );
    return runWithCommandContext(context, handlerFn);
  };
}

export default {
  runWithCommandContext,
  getCurrentContext,
  recordCommandUsage,
  recordApiCall,
  instrumentHttpClients,
  wrapWithUsageTracking,
};
export { instrumentHttpClients, wrapWithUsageTracking };
