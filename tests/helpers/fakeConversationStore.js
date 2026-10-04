// An in-memory stand-in for the AiConversation collection that behaves like the
// parts of MongoDB the conversation code relies on: exact-match filters,
// $push/$each/$slice, $set, $unset, upsert, the unique (chatId, senderId,
// personaId) index, and the TTL sweep (documents whose `expiresAt` has passed
// are deleted; documents WITHOUT `expiresAt` are never touched).

const AiConversation = require('../../models/AiConversation');

function install() {
  const docs = [];
  let nextId = 1;
  const original = {};
  const methods = ['findOne', 'findOneAndUpdate', 'updateMany', 'updateOne', 'deleteOne', 'find'];
  for (const name of methods) original[name] = AiConversation[name];

  const matches = (doc, filter) => Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && '$exists' in expected) {
      return (doc[key] !== undefined) === Boolean(expected.$exists);
    }
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && '$ne' in expected) return doc[key] !== expected.$ne;
    return doc[key] === expected;
  });

  const clone = value => JSON.parse(JSON.stringify(value), (key, v) => (key === 'expiresAt' && typeof v === 'string' ? new Date(v) : v));
  const view = doc => (doc ? Object.assign(clone(doc), { _id: doc._id }) : null);

  const applyUpdate = (doc, update) => {
    for (const [field, spec] of Object.entries(update.$push || {})) {
      doc[field] = (doc[field] || []).concat(spec.$each.map(item => ({ ...item })));
      if (spec.$slice !== undefined) doc[field] = doc[field].slice(spec.$slice);
    }
    for (const [field, value] of Object.entries(update.$set || {})) doc[field] = value;
    for (const field of Object.keys(update.$unset || {})) delete doc[field];
  };

  const violatesUnique = (candidate, ignoreId) => docs.some(d => d._id !== ignoreId
    && d.chatId === candidate.chatId && d.senderId === candidate.senderId && d.personaId === candidate.personaId);

  AiConversation.findOne = filter => Promise.resolve(view(docs.find(d => matches(d, filter))));
  AiConversation.find = filter => ({ lean: () => Promise.resolve(docs.filter(d => matches(d, filter)).map(view)) });
  AiConversation.findOneAndUpdate = (filter, update, options = {}) => {
    let doc = docs.find(d => matches(d, filter));
    if (!doc) {
      if (!options.upsert) return Promise.resolve(null);
      doc = { _id: `id${nextId++}`, ...filter, messages: [] };
      docs.push(doc);
    }
    applyUpdate(doc, update);
    return Promise.resolve(options.new ? view(doc) : null);
  };
  AiConversation.updateMany = (filter, update) => {
    const hit = docs.filter(d => matches(d, filter));
    hit.forEach(d => applyUpdate(d, update));
    return Promise.resolve({ modifiedCount: hit.length });
  };
  AiConversation.updateOne = (filter, update) => {
    const doc = docs.find(d => matches(d, filter));
    if (!doc) return Promise.resolve({ modifiedCount: 0 });
    const candidate = { ...doc, ...(update.$set || {}) };
    if (violatesUnique(candidate, doc._id)) return Promise.reject(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
    applyUpdate(doc, update);
    return Promise.resolve({ modifiedCount: 1 });
  };
  AiConversation.deleteOne = filter => {
    const index = docs.findIndex(d => matches(d, filter));
    if (index >= 0) docs.splice(index, 1);
    return Promise.resolve({ deletedCount: index >= 0 ? 1 : 0 });
  };

  return {
    docs,
    // What MongoDB's background TTL monitor does at time `now`.
    sweep(now) {
      for (let i = docs.length - 1; i >= 0; i -= 1) {
        const expiresAt = docs[i].expiresAt;
        if (expiresAt instanceof Date && expiresAt.getTime() <= now) docs.splice(i, 1);
      }
    },
    find: (chatId, senderId, personaId) => docs.find(d => d.chatId === chatId && d.senderId === senderId && d.personaId === personaId),
    insertLegacy(doc) { docs.push({ _id: `id${nextId++}`, messages: [], ...doc }); },
    restore() { for (const name of methods) AiConversation[name] = original[name]; },
  };
}

module.exports = { install };
