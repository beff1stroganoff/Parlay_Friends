const mongoose = require('mongoose');

const pickSchema = new mongoose.Schema({
  team: String,
  type: String,   // e.g., moneyline, spread, total, prop
  odds: Number
  // (optional later) won: Boolean
});

const parlaySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  leagueId: { type: mongoose.Schema.Types.ObjectId, ref: 'League' },
  week: Number,
  picks: [pickSchema],
  odds: Number,  // total decimal odds for the whole ticket
  result: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
  legsWon: { type: Number, default: 0 },
  legsLost: { type: Number, default: 0 },
  submittedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Parlay', parlaySchema);
