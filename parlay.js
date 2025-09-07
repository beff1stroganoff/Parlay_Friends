// parlay.js
const mongoose = require('mongoose');

const PickSchema = new mongoose.Schema(
  {
    team: { type: String },         // team or player name
    type: { type: String },         // 'total', 'player_pass_yds', etc.
    side: { type: String, default: null }, // 'Over' | 'Under' | 'Yes' | 'No' | null
    line: { type: Number, default: null }, // points/yds if applicable
    odds: { type: Number },         // American odds you store in picks
  },
  { _id: false }
);

const ParlaySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    leagueId: { type: mongoose.Schema.Types.ObjectId, ref: 'League', index: true, required: true },
    week: { type: Number, index: true, required: true },
    picks: { type: [PickSchema], default: [] },   // <-- was [String]
    odds: { type: Number, required: true },       // total decimal odds you already save
    submittedAt: { type: Date, default: Date.now }
  },
  { minimize: false, timestamps: false }
);

ParlaySchema.index({ leagueId: 1, week: 1 });
ParlaySchema.index({ userId: 1, leagueId: 1, week: 1 }, { unique: true });

module.exports = mongoose.model('Parlay', ParlaySchema);
