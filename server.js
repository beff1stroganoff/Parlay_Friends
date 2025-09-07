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


// Odds API proxy (public) – Sunday slate by NFL week (FanDuel core) + optional player props merge
app.get('/api/odds', async (req, res) => {
  const { sport } = req.query;
  if (!sport) return res.status(400).json({ error: 'Missing sport' });

  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_API_KEY) return res.status(500).json({ error: 'Missing ODDS_API_KEY on server' });

  const baseMarkets = req.query.baseMarkets || 'h2h,spreads,totals';
  const bookmakers = (req.query.bookmakers || 'fanduel').toLowerCase();
  const regions = req.query.regions || 'us';
  const oddsFormat = req.query.oddsFormat || 'decimal';

  // Week + Sunday flags
  const weekNum = Math.max(1, parseInt(req.query.week || '1', 10));
  const sundayOnly = ['1','true','yes'].includes(String(req.query.sundayOnly ?? '1').toLowerCase());
  const includeProps = ['1','true','yes'].includes(String(req.query.includeProps ?? '0').toLowerCase());

  // 2025 NFL Week 1 Sunday = Sep 7, 2025 (ET). Adjust per season if needed.
  const NFL_SEASON_START_SUNDAY_ET = (req.query.seasonStartEt || '2025-09-07').trim();

  const fmtETDate = (d) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d); // YYYY-MM-DD

  const etDateOfISO = (iso) => fmtETDate(new Date(iso));
  const isSundayET = (iso) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
      .format(new Date(iso)) === 'Sun';

  const etSundayForWeek = (n) => {
    const baseNoon = new Date(`${NFL_SEASON_START_SUNDAY_ET}T12:00:00-04:00`);
    const target = new Date(baseNoon.getTime() + (n - 1) * 7 * 24 * 60 * 60 * 1000);
    return fmtETDate(target); // YYYY-MM-DD for that Sunday in ET
  };

  // Props config (official keys)
  const PROP_KEYS = [
    'player_pass_yds',
    'player_reception_tds',
    'player_reception_yds',
    'player_rush_yds',
    'player_1st_td',
    'player_anytime_td'
  ];
  const PROPS_QS = PROP_KEYS.join(',');

  // Simple in-memory cache (5 minutes)
  const CACHE_TTL_MS = 5 * 60 * 1000;
  if (!global.__propsCache) global.__propsCache = new Map();
  const propsCache = global.__propsCache;
  const cacheKey = (eventId) => `${sport}:${bookmakers}:${eventId}:${PROPS_QS}`;
  const cacheGet = (key) => {
    const hit = propsCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.data;
    if (hit) propsCache.delete(key);
    return null;
  };
  const cacheSet = (key, data) => propsCache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function fetchPropsForEvent(eventId) {
    const key = cacheKey(eventId);
    const cached = cacheGet(key);
    if (cached) return cached;

    try {
      const r = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds`, {
        params: { apiKey: ODDS_API_KEY, regions, bookmakers, markets: PROPS_QS, oddsFormat },
        timeout: 15000
      });
      const books = Array.isArray(r.data?.bookmakers) ? r.data.bookmakers : [];
      cacheSet(key, books);
      return books;
    } catch (e) {
      if (e.response?.data?.error_code === 'EXCEEDED_FREQ_LIMIT') {
        // Serve stale if we have it; else empty
        return cached || [];
      }
      return [];
    }
  }

  try {
    // 1) Core list call (no player_* props here)
    const core = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds`, {
      params: { apiKey: ODDS_API_KEY, regions, bookmakers, markets: baseMarkets, oddsFormat },
      timeout: 15000
    });

    let games = Array.isArray(core.data) ? core.data : [];

    // 2) Sunday-only filter by selected week (ET)
    if (sundayOnly) {
      const targetSundayET = etSundayForWeek(weekNum);
      games = games.filter(g => isSundayET(g.commence_time) && etDateOfISO(g.commence_time) === targetSundayET);
    }

    // If not fetching props, return core-only Sunday slate
    if (!includeProps || games.length === 0) {
      res.set('Access-Control-Expose-Headers', 'X-Props-Present');
      res.set('X-Props-Present', 'false');
      return res.json(games);
    }

    // 3) Fetch props per filtered game (gentle on rate limits)
    const queue = [...games];
    const CONCURRENCY = 2;
    let propsFound = 0;

    async function worker() {
      while (queue.length) {
        const g = queue.shift();
        if (!g?.id) continue;

        const propsBooks = await fetchPropsForEvent(g.id);
        if (propsBooks.length) {
          g.bookmakers = Array.isArray(g.bookmakers) ? g.bookmakers : [];
          const byKey = new Map(g.bookmakers.map(b => [String(b.key || '').toLowerCase(), b]));

          for (const bk of propsBooks) {
            const key = String(bk.key || bk.bookmaker?.key || '').toLowerCase();
            if (!key) continue;
            const title = bk.title || bk.bookmaker?.title || key;

            let coreBk = byKey.get(key);
            if (!coreBk) {
              coreBk = { key, title, markets: [] };
              g.bookmakers.push(coreBk);
              byKey.set(key, coreBk);
            }
            coreBk.markets = Array.isArray(coreBk.markets) ? coreBk.markets : [];

            for (const m of (bk.markets || [])) {
              if (!PROP_KEYS.includes(m.key)) continue;
              const i = coreBk.markets.findIndex(x => x.key === m.key);
              if (i >= 0) coreBk.markets[i] = m; else coreBk.markets.push(m);
              if (Array.isArray(m.outcomes) && m.outcomes.length) propsFound++;
            }
          }
        }

        // gentle backoff between event calls
        await sleep(300);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    res.set('Access-Control-Expose-Headers', 'X-Props-Present');
    res.set('X-Props-Present', String(propsFound > 0));
    return res.json(games);

  } catch (err) {
    console.error('Error fetching odds:', err.response?.data || err.message);
    res.set('Access-Control-Expose-Headers', 'X-Props-Present');
    res.set('X-Props-Present', 'false');
    return res.status(500).json({ error: 'Failed to fetch odds', details: err.response?.data || err.message });
  }
});






// Submit parlay (requires auth)
app.post('/api/parlay/submit', async (req, res) => {
  const userId = req.user?.id;
  const { leagueId, week, picks, odds } = req.body;

  // If token is expired/invalid, send a clear 401 so the client can re-login
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized (token expired or invalid). Please log in again.' });
  }

  // Stricter validation to avoid vague errors
  const weekNum = Number(week);
  const oddsNum = Number(odds);
  if (!leagueId || !Number.isFinite(weekNum) || !Array.isArray(picks) || !Number.isFinite(oddsNum) || picks.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid parlay data.' });
  }

  try {
    
const normPicks = (Array.isArray(picks) ? picks : []).map(p => ({
  team: String(p.team ?? ''),
  type: String(p.type ?? ''),
  side: p.side != null ? String(p.side) : null,
  line: (p.line === '' || p.line == null) ? null : Number(p.line),
  odds: Number(p.odds)
}));

const parlayDoc = await Parlay.findOneAndUpdate(
  { userId, leagueId, week: weekNum },
  { $set: { picks: normPicks, odds: oddsNum, submittedAt: new Date() } },
  { upsert: true, new: true }
);

    return res.status(200).json({ message: 'Parlay submitted successfully!', parlayId: parlayDoc._id });
  } catch (err) {
    console.error('Error saving parlay:', err);
    return res.status(500).json({ error: 'Server error saving parlay.' });
  }
});



//load week button blocker
function requireAuth(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  next();
}


// Weekly parlays (requires auth + you must have submitted to view others)
app.get('/api/parlay/week/:leagueId/:week', requireAuth, async (req, res) => {
  const { leagueId, week } = req.params;
  try {
    const me = await Parlay.findOne({ leagueId, userId: req.user.id, week });
    if (!me) {
      return res.status(403).json({ error: 'Submit your parlay for this week to view others.' });
    }
    const parlays = await Parlay.find({ leagueId, week }).populate('userId', 'username');
    res.json(parlays);
  } catch (err) {
    console.error('Error fetching weekly picks:', err);
    res.status(500).json({ error: 'Server error fetching picks' });
  }
});


// Did I submit my parlay for this week? (requires auth)
app.get('/api/parlay/mine/:leagueId/:week', requireAuth, async (req, res) => {
  const { leagueId, week } = req.params;
  try {
    const mine = await Parlay.findOne({ leagueId, userId: req.user.id, week });
    res.json({ submitted: !!mine });
  } catch (err) {
    console.error('Error checking my parlay:', err);
    res.status(500).json({ error: 'Server error' });
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
