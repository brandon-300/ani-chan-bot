const mongoose = require('mongoose');

const AnswerSchema = new mongoose.Schema({
  question: { type: String, required: true, maxlength: 300 },
  answer: { type: String, enum: ['yes', 'no', 'idk', 'prob', 'probnot'], required: true },
  questionNumber: { type: Number, required: true, min: 1 },
  answeredAt: { type: Date, default: Date.now },
}, { _id: false });

const CandidateHistorySchema = new mongoose.Schema({
  candidate: { type: String, default: '', maxlength: 160 },
  anime: { type: String, default: '', maxlength: 160 },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  recordedAt: { type: Date, default: Date.now },
}, { _id: false });

const AkinatorSessionSchema = new mongoose.Schema({
  chatId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active', index: true },
  questionNumber: { type: Number, default: 0, min: 0 },
  currentQuestion: { type: String, default: '', maxlength: 300 },
  currentQuestionMessageId: { type: String, default: '' },
  questionMessageIds: { type: [String], default: [] },
  answers: { type: [AnswerSchema], default: [] },
  questionsAsked: { type: [String], default: [] },
  pendingAnswer: {
    questionMessageId: { type: String, default: '' },
    question: { type: String, default: '', maxlength: 300 },
    answer: { type: String, enum: ['yes', 'no', 'idk', 'prob', 'probnot'] },
  },
  candidate: { type: String, default: '', maxlength: 160 },
  candidateAnime: { type: String, default: '', maxlength: 160 },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  runnerUpCandidate: { type: String, default: '', maxlength: 160 },
  runnerUpConfidence: { type: Number, min: 0, max: 1, default: 0 },
  supportingAnswerNumbers: { type: [Number], default: [] },
  contradictingAnswerNumbers: { type: [Number], default: [] },
  candidateHistory: { type: [CandidateHistorySchema], default: [] },
  // The model's own notebook: conclusions drawn from the answers and topics/series ruled out.
  // They are fed back into every prompt so settled things are never asked about again.
  knownFacts: { type: [String], default: [] },
  ruledOut: { type: [String], default: [] },
  // Times the bot was ready to guess but could not match the character to a real
  // AniList/MyAnimeList entry (see AKINATOR_UNVERIFIED_GUESS_AFTER).
  verificationFailures: { type: Number, default: 0, min: 0 },
  endReason: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, minimize: false });

AkinatorSessionSchema.index({ chatId: 1, userId: 1 }, { unique: true, name: 'akinator_chat_user_unique' });
AkinatorSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'akinator_session_ttl' });

module.exports = mongoose.models.AkinatorSession || mongoose.model('AkinatorSession', AkinatorSessionSchema);
