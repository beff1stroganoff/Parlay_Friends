// parlay.js
const mongoose = require('mongoose');

const PickSchema = new mongoose.Schema(
  {
    team: { type: String },                     // team or player
    type: { type: String },                     // 'total', 'player_pass_yds', etc.
    side: { type: String, default: null },      // 'Over' | 'Under' | 'Yes' | 'No' | null
    line: { type: Number, default: null },      // points/yds if applicable
    odds: { type: Number }, 
    matchup: {type: String},                    // American odds per leg (as you store in picks)
    result: { type: String, enum: ['pending','won','lost','push'], default: 'pending' }
  },
  { _id: false }
);

const ParlaySchema = new mongoose.Schema(
  {
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    leagueId: { type: mongoose.Schema.Types.ObjectId, ref: 'League', index: true, required: true },
    week:     { type: Number, index: true, required: true },

    picks: { type: [PickSchema], default: [] }, // array of objects (not strings)
    odds:  { type: Number, required: true },    // total decimal odds

    // 🔽 add these so settlement persists
    result:   { type: String, enum: ['pending','won','lost'], default: 'pending' },
    legsWon:  { type: Number, default: 0 },
    legsLost: { type: Number, default: 0 },

    submittedAt: { type: Date, default: Date.now }
  },
  { minimize: false }
);

ParlaySchema.index({ leagueId: 1, week: 1 });
ParlaySchema.index({ userId: 1, leagueId: 1, week: 1 }, { unique: true });

module.exports = mongoose.model('Parlay', ParlaySchema);
