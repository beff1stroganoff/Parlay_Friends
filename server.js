// --- server.js (same-origin ready) ---
require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');          // not required for same-origin, but harmless
const axios = require('axios');
const Parlay = require('./parlay');

const app = express();

// ===== Env & Safety =====
const PORT = process.env.PORT || 3000;

// IMPORTANT: use exactly the var you put in .env (you said MONGO_URI=...)
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌ Missing MONGO_URI (or MONGODB_URI) in .env');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ Missing JWT_SECRET in .env');
  process.exit(1);
}

const ODDS_API_KEY = process.env.ODDS_API_KEY; // optional until you hit /api/odds

// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Same-origin static hosting (serves your HTML/CSS/JS from this folder)
app.use(express.static(path.join(__dirname)));

// CORS note: for same-origin you don't need it. Keeping it minimal is fine.
app.use(cors());

// Tiny health check for quick testing
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ===== DB Connect =====
mongoose.set('strictQuery', true);
mongoose
  .connect(MONGO_URI, { maxPoolSize: 20, serverSelectionTimeoutMS: 10000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ Error connecting to MongoDB:', err.message); process.exit(1); });

// ===== Schemas =====
const userSchema = new mongoose.Schema({
  username: String,
  password: String,
  leagueName: { type: String, default: null },
  passkey: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

const leagueSchema = new mongoose.Schema({
  name: String,
  passkey: String,
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  settings: {
    leagueType: { type: String, enum: ['classic', 'points'], required: true },
    startingBucs: Number,
    pointsPerWin: Number,
    bonusWeek: Number,
    bonusSeason: Number,
    minTotalOdds: { type: Number, required: true },
    minLegOdds: { type: Number, required: true },
    numLegs: { type: Number, required: true },
    submissionDeadline: { type: String, required: true }
  },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  parlays: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    week: Number,
    picks: [String],
    odds: Number,
    result: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
  }]
});
const League = mongoose.model('League', leagueSchema);

// ===== Helpers =====
function validateSettings(settings) {
  const errors = [];
  if (!['classic', 'points'].includes(settings.leagueType)) errors.push('Invalid league type');

  if (settings.leagueType === 'classic' && typeof settings.startingBucs !== 'number') {
    errors.push('Classic leagues must include startingBucs (number)');
  }
  if (settings.leagueType === 'points') {
    if (typeof settings.pointsPerWin !== 'number') errors.push('Points leagues must include pointsPerWin');
    if (typeof settings.bonusWeek !== 'number') errors.push('Points leagues must include bonusWeek');
    if (typeof settings.bonusSeason !== 'number') errors.push('Points leagues must include bonusSeason');
  }

  if (typeof settings.minTotalOdds !== 'number') errors.push('Missing or invalid minTotalOdds');
  if (typeof settings.minLegOdds !== 'number') errors.push('Missing or invalid minLegOdds');
  if (typeof settings.numLegs !== 'number') errors.push('Missing or invalid numLegs');
  if (typeof settings.submissionDeadline !== 'string') errors.push('Missing or invalid submissionDeadline');

  return errors;
}

// Auth decode (non-blocking). Protected routes will check req.user.
app.use((req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (err) {
      console.error('JWT error:', err.message);
    }
  }
  next();
});

// ===== Routes =====

// Register
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ error: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();
    res.status(201).json({ message: 'User registered successfully' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });

    res.json({
      token,
      username: user.username,
      userId: user._id,
      leagueName: user.leagueName || null,
      passkey: user.passkey || null
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create League (requires auth)
app.post('/create-league', async (req, res) => {
  const { leagueName, passkey } = req.body;
  if (!leagueName || !passkey) {
    return res.status(400).json({ error: 'League name and passkey are required' });
  }
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const existingLeague = await League.findOne({
      name: { $regex: `^${leagueName}$`, $options: 'i' }
    });
    if (existingLeague) {
      return res.status(409).json({ error: 'A league with this name already exists.' });
    }

    const defaultSettings = {
      leagueType: 'classic',
      startingBucs: 5000,
      minTotalOdds: 500,
      minLegOdds: -150,
      numLegs: 3,
      submissionDeadline: 'Sunday 12:00 PM'
    };

    const validationErrors = validateSettings(defaultSettings);
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: validationErrors.join(', ') });
    }

    const newLeague = new League({
      name: leagueName,
      passkey,
      creator: userId,
      settings: defaultSettings
    });

    const savedLeague = await newLeague.save();
    res.status(201).json({ message: 'League created successfully', leagueId: savedLeague._id });
  } catch (err) {
    console.error('Error creating league:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update League Settings (requires auth, must be creator)
app.post('/api/league-settings', async (req, res) => {
  const { leagueId, leagueType, startingBucs, pointsPerWin, bonusWeek, bonusSeason, minTotalOdds, minLegOdds, numLegs, submissionDeadline } = req.body;
  if (!leagueId || !leagueType || !minTotalOdds || !minLegOdds || !numLegs || !submissionDeadline) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  try {
    const league = await League.findById(leagueId);
    if (!league) return res.status(404).json({ error: 'League not found.' });
    if (league.creator.toString() !== req.user?.id) {
      return res.status(403).json({ error: 'Not authorized to edit this league' });
    }

    const settingsPayload = {
      leagueType,
      startingBucs: leagueType === 'classic' ? startingBucs : undefined,
      pointsPerWin: leagueType === 'points' ? pointsPerWin : undefined,
      bonusWeek: leagueType === 'points' ? bonusWeek : undefined,
      bonusSeason: leagueType === 'points' ? bonusSeason : undefined,
      minTotalOdds,
      minLegOdds,
      numLegs,
      submissionDeadline
    };

    const validationErrors = validateSettings(settingsPayload);
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: validationErrors.join(', ') });
    }

    league.settings = settingsPayload;
    await league.save();
    res.status(200).json({ message: 'League settings saved successfully.' });
  } catch (err) {
    console.error('Error saving league settings:', err);
    res.status(500).json({ error: 'Server error saving league settings.' });
  }
});

// Join League (requires auth)
app.post('/api/leagues/join', async (req, res) => {
  const { leagueId, passkey } = req.body;
  const userId = req.user?.id;
  if (!leagueId || !passkey || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const league = await League.findById(leagueId);
    if (!league) return res.status(404).json({ error: 'League not found' });

    if (league.passkey !== passkey) {
      return res.status(403).json({ error: 'Incorrect passkey' });
    }

    if (league.members.includes(userId)) {
      return res.status(200).json({ message: 'Already a member of this league' });
    }

    league.members.push(userId);
    await league.save();
    res.status(200).json({ message: 'Successfully joined the league!' });
  } catch (err) {
    console.error('Join league error:', err);
    res.status(500).json({ error: 'Server error joining league' });
  }
});

// Get league by ID (public)
app.get('/league/:id', async (req, res) => {
  try {
    const league = await League.findById(req.params.id).populate('creator', 'username');
    if (!league) return res.status(404).json({ error: 'League not found' });
    res.json(league);
  } catch (err) {
    console.error('Error fetching league:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// League search (public)
app.get('/api/leagues/search', async (req, res) => {
  const leagueName = req.query.name;
  if (!leagueName) return res.status(400).json({ error: 'League name required' });

  try {
    const leagues = await League.find({
      name: { $regex: leagueName, $options: 'i' }
    }).sort({ name: 1 });

    if (!leagues.length) return res.status(404).json({ error: 'No matching leagues found' });
    res.json(leagues);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Server error searching league' });
  }
});

// User's leagues (public by username; consider protecting later)
app.get('/api/user-leagues', async (req, res) => {
  const username = req.query.username;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const leagues = await League.find({ members: user._id });
    res.json(leagues);
  } catch (err) {
    console.error('Error fetching user leagues:', err);
    res.status(500).json({ error: 'Server error fetching leagues' });
  }
});

// Odds API proxy (public)
app.get('/api/odds', async (req, res) => {
  const { sport } = req.query;
  if (!sport) return res.status(400).json({ error: 'Missing sport' });

  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_API_KEY) return res.status(500).json({ error: 'Missing ODDS_API_KEY on server' });

  // Core + desired props (canonical keys The Odds API uses most consistently)
  const baseMarkets = 'h2h,spreads,totals';
  const propMarkets = [
    'player_rush_yds',
    'player_anytime_td',
    'player_first_td',       // canonical (UI also accepts player_1st_td)
    'player_receiving_yds',  // canonical (UI also accepts player_reception_yds)
    'player_receptions',
    'player_pass_yds'
  ].join(',');

  // Many props show up only at certain books; limit to books that typically carry props.
  const bookmakers = 'draftkings,fanduel,betmgm,caesars,pointsbetus';

  // helper to see if any game actually contains a player_ market
  const hasProps = (arr) => Array.isArray(arr) && arr.some(g =>
    Array.isArray(g.bookmakers) && g.bookmakers.some(b =>
      Array.isArray(b.markets) && b.markets.some(m => String(m.key || '').startsWith('player_')
    ))
  );

  try {
    // 1) Ask for core + props from prop-friendly bookmakers
    const withProps = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds`, {
      params: {
        apiKey: ODDS_API_KEY,
        regions: 'us',
        bookmakers,
        markets: `${baseMarkets},${propMarkets}`,
        oddsFormat: 'decimal'
      },
      timeout: 15000
    });

    if (hasProps(withProps.data)) {
      return res.json(withProps.data);
    }

    // 2) If we didn’t get any player_ markets back, return what we have but
    //    include a diagnostic header so we can see this easily in the Network tab.
    res.set('X-Props-Present', 'false');
    return res.json(withProps.data);

  } catch (err1) {
    console.warn('Props request failed, falling back to core:', err1.response?.data || err1.message);

    try {
      const coreOnly = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds`, {
        params: {
          apiKey: ODDS_API_KEY,
          regions: 'us',
          bookmakers,
          markets: baseMarkets,
          oddsFormat: 'decimal'
        },
        timeout: 15000
      });
      res.set('X-Props-Present', 'false');
      return res.json(coreOnly.data);
    } catch (err2) {
      console.error('Error fetching odds:', err2.response?.data || err2.message);
      return res.status(500).json({
        error: 'Failed to fetch odds',
        details: err2.response?.data || err2.message
      });
    }
  }
});


// Submit parlay (requires auth)
app.post('/api/parlay/submit', async (req, res) => {
  const userId = req.user?.id;
  const { leagueId, week, picks, odds } = req.body;

  if (!userId || !leagueId || !week || !Array.isArray(picks) || !odds) {
    return res.status(400).json({ error: 'Missing required parlay data.' });
  }
  try {
    const parlayDoc = await Parlay.findOneAndUpdate(
      { userId, leagueId, week },
      { $set: { picks, odds, submittedAt: new Date() } },
      { upsert: true, new: true }
    );
    res.status(200).json({ message: 'Parlay submitted successfully!', parlayId: parlayDoc._id });
  } catch (err) {
    console.error('Error saving parlay:', err);
    res.status(500).json({ error: 'Server error saving parlay.' });
  }
});

// Weekly parlays (public)
app.get('/api/parlay/week/:leagueId/:week', async (req, res) => {
  const { leagueId, week } = req.params;
  try {
    const parlays = await Parlay.find({ leagueId, week }).populate('userId', 'username');
    res.json(parlays);
  } catch (err) {
    console.error('Error fetching weekly picks:', err);
    res.status(500).json({ error: 'Server error fetching picks' });
  }
});

// Settle parlay (requires auth & must be league creator)
app.post('/api/parlay/settle', async (req, res) => {
  const userId = req.user?.id;
  const { leagueId, targetUserId, week, result, legsWon, legsLost } = req.body;

  if (!leagueId || !targetUserId || !week || !['won','lost','pending'].includes(result)) {
    return res.status(400).json({ error: 'Missing or invalid fields.' });
  }
  try {
    const league = await League.findById(leagueId);
    if (!league) return res.status(404).json({ error: 'League not found.' });
    if (league.creator.toString() !== userId) {
      return res.status(403).json({ error: 'Not authorized to settle parlays for this league.' });
    }

    const parlay = await Parlay.findOne({ leagueId, userId: targetUserId, week });
    if (!parlay) return res.status(404).json({ error: 'Parlay not found for that user/week.' });

    parlay.result = result;
    parlay.legsWon = Number.isFinite(legsWon) ? legsWon : parlay.legsWon;
    parlay.legsLost = Number.isFinite(legsLost) ? legsLost : parlay.legsLost;
    await parlay.save();

    res.json({ message: 'Parlay settled.', parlayId: parlay._id });
  } catch (err) {
    console.error('Error settling parlay:', err);
    res.status(500).json({ error: 'Server error settling parlay.' });
  }
});

// League season stats (public)
app.get('/api/league/:leagueId/stats', async (req, res) => {
  const { leagueId } = req.params;
  try {
    const parlays = await Parlay.find({ leagueId }).populate('userId', 'username');

    const byUser = new Map(); // userId -> { username, legsWon, legsLost, parlayWins, parlayLosses, points }
    const ensure = (uid, uname) => {
      if (!byUser.has(uid)) byUser.set(uid, { username: uname, legsWon: 0, legsLost: 0, parlayWins: 0, parlayLosses: 0, points: 0 });
      return byUser.get(uid);
    };

    // Base counts (1 pt per parlay win)
    for (const p of parlays) {
      const u = ensure(p.userId._id.toString(), p.userId.username);
      u.legsWon += p.legsWon || 0;
      u.legsLost += p.legsLost || 0;
      if (p.result === 'won') { u.parlayWins += 1; u.points += 1; }
      if (p.result === 'lost') { u.parlayLosses += 1; }
    }

    // Weekly longest winning odds: +2
    const byWeek = new Map();
    for (const p of parlays) {
      if (p.result === 'won') {
        const list = byWeek.get(p.week) || [];
        list.push(p);
        byWeek.set(p.week, list);
      }
    }
    for (const wins of byWeek.values()) {
      if (wins.length === 0) continue;
      const maxOdds = Math.max(...wins.map(p => Number(p.odds) || 0));
      wins.filter(p => Number(p.odds) === maxOdds).forEach(p => {
        const u = byUser.get(p.userId._id.toString());
        if (u) u.points += 2;
      });
    }

    // Season longest winning odds: +5
    const winning = parlays.filter(p => p.result === 'won');
    if (winning.length > 0) {
      const seasonMax = Math.max(...winning.map(p => Number(p.odds) || 0));
      winning.filter(p => Number(p.odds) === seasonMax).forEach(p => {
        const u = byUser.get(p.userId._id.toString());
        if (u) u.points += 5;
      });
    }

    const out = [...byUser.values()].sort((a, b) => b.points - a.points);
    res.json(out);
  } catch (err) {
    console.error('Error computing league stats:', err);
    res.status(500).json({ error: 'Server error computing stats.' });
  }
});

// ===== Start the Server =====
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
