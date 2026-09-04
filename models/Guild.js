// Guild member shape upgraded from a bare array of user-id strings to an
// array of small role/contribution records — this is what unlocks
// leader/officer/veteran/member permissions and a per-member contribution
// score. Existing guilds created under the old `members: [String]` shape
// MUST be run through migrateGuildMembers.js before this schema is
// deployed — see that file's header comment for why (Mongoose throws a
// CastError trying to hydrate a raw string into this subdocument shape
// otherwise).
const mongoose = require('mongoose');

const ROLES = ['leader', 'officer', 'veteran', 'member'];
// Higher number = more senior. Used by .guild promote/.guild demote to
// step a member one rank up/down, and by leadership-handoff logic, without
// hardcoding the role order in more than one place.
const ROLE_RANK = { leader: 3, officer: 2, veteran: 1, member: 0 };

const GuildMemberSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  role: { type: String, enum: ROLES, default: 'member' },
  joinedAt: { type: Date, default: Date.now },
  contribution: { type: Number, default: 0 },
}, { _id: false });

const GuildSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  leaderId: { type: String, required: true },
  members: { type: [GuildMemberSchema], default: [] },
  pendingInvites: { type: [String], default: [] },
  emblem: { type: String, default: '🏰' },
  description: { type: String, default: '' },
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  bank: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

GuildSchema.statics.ROLES = ROLES;
GuildSchema.statics.ROLE_RANK = ROLE_RANK;

module.exports = mongoose.model('Guild', GuildSchema);
