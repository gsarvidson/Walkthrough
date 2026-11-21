require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { OAuth } = require('oauth');
const db = require('./db');
const { isProperty, mapListing } = require('./listing');
const { buildChecklist } = require('./questions');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const isSandbox = (process.env.TM_ENV || 'sandbox') !== 'production';
const TM_BASE = isSandbox ? 'https://api.tmsandbox.co.nz/v1' : 'https://api.trademe.co.nz/v1';
const TM_AUTH = isSandbox ? 'https://secure.tmsandbox.co.nz' : 'https://secure.trademe.co.nz';
const TM_WEB = isSandbox ? 'https://www.tmsandbox.co.nz' : 'https://www.trademe.co.nz';
const onRender = !!process.env.RENDER;

const oa = new OAuth(
  `${TM_AUTH}/Oauth/RequestToken?scope=MyTradeMeRead`,
  `${TM_AUTH}/Oauth/AccessToken`,
  process.env.TM_CONSUMER_KEY,
  process.env.TM_CONSUMER_SECRET,
  '1.0',
  'oob', // PIN flow
  'HMAC-SHA1'
);

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  store: db.sessionStore(session),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: onRender, maxAge: 1000 * 60 * 60 * 24 * 90 }
}));

// ── TRADE ME API HELPER ──────────────────────────────────────────────────────
function tmGet(req, path, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `${TM_BASE}/${path}.json${qs ? '?' + qs : ''}`;
    oa.get(url, req.session.token, req.session.tokenSecret, (err, data) => {
      if (err) {
        const e = new Error(`Trade Me API error on ${path}`);
        e.status = err.statusCode || 502;
        e.detail = err.data;
        return reject(e);
      }
      try { resolve(JSON.parse(data)); } catch { reject(new Error(`Bad response from ${path}`)); }
    });
  });
}

function requireAuth(req, res, next) {
  if (!req.session.token || !req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  next();
}

// ── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  oa.getOAuthRequestToken((err, token, secret) => {
    if (err) {
      console.error('Request token error:', err);
      return res.json({ error: 'Could not connect to Trade Me. Check the consumer key and secret.' });
    }
    req.session.requestToken = token;
    req.session.requestTokenSecret = secret;
    res.json({ authorizeUrl: `${TM_AUTH}/Oauth/Authorize?oauth_token=${token}` });
  });
});

app.post('/auth/pin', (req, res) => {
  const pin = String((req.body && req.body.pin) || '').trim();
  const { requestToken, requestTokenSecret } = req.session;
  if (!requestToken) return res.json({ success: false, error: 'Session expired. Please start again.' });

  oa.getOAuthAccessToken(requestToken, requestTokenSecret, pin, async (err, token, secret) => {
    if (err) {
      console.error('Access token error:', err);
      return res.json({ success: false, error: 'That PIN didn’t work. Please try again.' });
    }
    req.session.token = token;
    req.session.tokenSecret = secret;
    delete req.session.requestToken;
    delete req.session.requestTokenSecret;
    try {
      const me = await tmGet(req, 'MyTradeMe/Summary');
      const userId = await db.upsertUser(me.MemberId, me.Nickname);
      req.session.userId = userId;
      req.session.nickname = me.Nickname || '';
      res.json({ success: true });
    } catch (e) {
      console.error('Member lookup failed:', e.message, e.detail || '');
      req.session.destroy(() => {});
      res.json({ success: false, error: 'Signed in, but couldn’t load your Trade Me profile. Please try again.' });
    }
  });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth-status', (req, res) => {
  res.json({ authenticated: !!(req.session.token && req.session.userId), nickname: req.session.nickname || '' });
});

// ── PROPERTIES ───────────────────────────────────────────────────────────────
app.get('/api/properties', requireAuth, async (req, res) => {
  try {
    const properties = await db.listProperties(req.session.userId);
    const lastSync = await db.lastSync(req.session.userId);
    const categories = await db.getCategories(req.session.userId);
    res.json({ properties, lastSync, categories });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your properties.' });
  }
});

// Pull the member's watchlist, keep property listings, fetch details (open homes, agent).
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const wl = await tmGet(req, 'MyTradeMe/Watchlist/All', { page, rows: 100 });
      const list = wl.List || [];
      items.push(...list);
      if (items.length >= (wl.TotalCount || 0) || list.length === 0) break;
    }
    const propertyItems = items.filter(isProperty);

    const mapped = [];
    const queue = [...propertyItems];
    async function worker() {
      while (queue.length) {
        const item = queue.shift();
        let detail = null;
        try { detail = await tmGet(req, `Listings/${item.ListingId}`); } catch (e) { /* closed listing etc. */ }
        mapped.push(mapListing(item, detail, TM_WEB));
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);

    await db.saveSync(req.session.userId, mapped);
    const properties = await db.listProperties(req.session.userId);
    const lastSync = await db.lastSync(req.session.userId);
    res.json({ properties, lastSync, watchlistCount: items.length, propertyCount: mapped.length });
  } catch (e) {
    console.error('Sync failed:', e.message, e.detail || '');
    if (e.status === 401) return res.status(401).json({ error: 'Your Trade Me sign-in has expired. Please sign in again.' });
    res.status(502).json({ error: 'Couldn’t sync with Trade Me just now. Please try again.' });
  }
});

// ── PROPERTY HUB: visits, notes, photos ──────────────────────────────────────
const ROOMS = ['General', 'Entrance', 'Lounge', 'Kitchen', 'Dining', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'Bedroom 4',
  'Bathroom', 'Ensuite', 'Laundry', 'Garage', 'Outdoor', 'Street'];
const cleanRoom = (r) => (ROOMS.includes(r) ? r : 'General');
const listingParam = (req) => Number(req.params.listingId);
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });

app.get('/api/properties/:listingId', requireAuth, wrap(async (req, res) => {
  const uid = req.session.userId;
  const p = await db.getProperty(uid, listingParam(req));
  if (!p) return res.status(404).json({ error: 'Property not found' });
  p.ratings = await db.getRatings(uid, p.listingId);
  p.checklist = buildChecklist(p.listingType, await db.getChecklist(uid, p.listingId));
  res.json({ property: p, rooms: ROOMS, categories: await db.getCategories(uid) });
}));

// ── RATINGS ──────────────────────────────────────────────────────────────────
const cleanCat = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);

app.put('/api/properties/:listingId/ratings', requireAuth, wrap(async (req, res) => {
  const uid = req.session.userId;
  const p = await db.getProperty(uid, listingParam(req));
  if (!p) return res.status(404).json({ error: 'Property not found' });
  if (!p.visits.length) return res.status(403).json({ error: 'Tap “I’m here” first to start rating.' });
  const category = cleanCat(req.body.category);
  const score = Math.max(0, Math.min(5, Math.round(Number(req.body.score) || 0)));
  if (!(await db.getCategories(uid)).includes(category)) return res.status(400).json({ error: 'Unknown category' });
  await db.setRating(uid, p.listingId, category, score);
  res.json({ success: true });
}));

// Replace the member's category list. Renames carry existing ratings across.
app.put('/api/categories', requireAuth, wrap(async (req, res) => {
  const uid = req.session.userId;
  const seen = new Set();
  const cats = (Array.isArray(req.body.categories) ? req.body.categories : [])
    .map(cleanCat).filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase())).slice(0, 20);
  if (!cats.length) return res.status(400).json({ error: 'Keep at least one category' });
  const renames = req.body.renames && typeof req.body.renames === 'object' ? req.body.renames : {};
  for (const [from, to] of Object.entries(renames)) {
    const f = cleanCat(from), t = cleanCat(to);
    if (f && t && f !== t && cats.includes(t)) await db.renameCategory(uid, f, t);
  }
  await db.setCategories(uid, cats);
  res.json({ categories: cats });
}));

// ── QUESTIONS & CHECKS ───────────────────────────────────────────────────────
app.put('/api/properties/:listingId/checklist/:key', requireAuth, wrap(async (req, res) => {
  const uid = req.session.userId;
  const p = await db.getProperty(uid, listingParam(req));
  if (!p) return res.status(404).json({ error: 'Property not found' });
  const item = buildChecklist(p.listingType, await db.getChecklist(uid, p.listingId)).find((i) => i.key === req.params.key);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  await db.saveChecklistItem(uid, p.listingId, item.key, {
    kind: item.kind, text: item.custom ? item.text : null, custom: item.custom,
    done: req.body.done !== undefined ? !!req.body.done : item.done,
    answer: req.body.answer !== undefined ? String(req.body.answer).slice(0, 2000) : item.answer
  });
  res.json({ success: true });
}));

app.post('/api/properties/:listingId/checklist', requireAuth, wrap(async (req, res) => {
  const uid = req.session.userId;
  const p = await db.getProperty(uid, listingParam(req));
  if (!p) return res.status(404).json({ error: 'Property not found' });
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Write something first' });
  const kind = req.body.kind === 'check' ? 'check' : 'ask';
  const key = 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await db.saveChecklistItem(uid, p.listingId, key, { kind, text, custom: true, done: false, answer: '' });
  res.json({ key });
}));

app.delete('/api/properties/:listingId/checklist/:key', requireAuth, wrap(async (req, res) => {
  await db.deleteChecklistItem(req.session.userId, listingParam(req), req.params.key);
  res.json({ success: true });
}));

// "I'm here" works any time. If it falls within an advertised open home (±30 min) it's tagged as such.
app.post('/api/properties/:listingId/checkin', requireAuth, wrap(async (req, res) => {
  const p = await db.getProperty(req.session.userId, listingParam(req));
  if (!p) return res.status(404).json({ error: 'Property not found' });
  const now = Date.now(), pad = 30 * 60 * 1000;
  const inWindow = (p.openHomes || []).some((o) => {
    const s = new Date(o.start).getTime(), e = new Date(o.end || o.start).getTime();
    return now >= s - pad && now <= e + pad;
  });
  const kind = inWindow ? (p.listingType === 'For rent' ? 'Advertised viewing' : 'Open home') : 'Private viewing';
  const id = await db.addVisit(req.session.userId, p.listingId, kind);
  res.json({ id, kind });
}));

app.delete('/api/visits/:id', requireAuth, wrap(async (req, res) => {
  await db.deleteVisit(req.session.userId, Number(req.params.id));
  res.json({ success: true });
}));

app.post('/api/properties/:listingId/notes', requireAuth, wrap(async (req, res) => {
  const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: 'Note is empty' });
  const p = await db.getProperty(req.session.userId, listingParam(req));
  if (!p) return res.status(404).json({ error: 'Property not found' });
  if (!p.visits.length) return res.status(403).json({ error: 'Tap “I’m here” first to start adding notes.' });
  const id = await db.addNote(req.session.userId, p.listingId, cleanRoom(req.body.room), body);
  res.json({ id });
}));

app.delete('/api/notes/:id', requireAuth, wrap(async (req, res) => {
  await db.deleteNote(req.session.userId, Number(req.params.id));
  res.json({ success: true });
}));

// Photos arrive already resized on the phone (JPEG, ~1600px), sent as the raw request body.
app.post('/api/properties/:listingId/photos', requireAuth,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '6mb' }),
  wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No photo received' });
    const p = await db.getProperty(req.session.userId, listingParam(req));
    if (!p) return res.status(404).json({ error: 'Property not found' });
    if (!p.visits.length) return res.status(403).json({ error: 'Tap “I’m here” first to start adding photos.' });
    const id = await db.addPhoto(req.session.userId, p.listingId, cleanRoom(req.query.room), req.headers['content-type'], req.body);
    res.json({ id });
  }));

app.get('/api/photos/:id', requireAuth, wrap(async (req, res) => {
  const ph = await db.getPhoto(req.session.userId, Number(req.params.id));
  if (!ph) return res.status(404).end();
  res.set('Content-Type', ph.mime).set('Cache-Control', 'private, max-age=86400').send(ph.data);
}));

app.delete('/api/photos/:id', requireAuth, wrap(async (req, res) => {
  await db.deletePhoto(req.session.userId, Number(req.params.id));
  res.json({ success: true });
}));

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
db.init().then(() => {
  app.listen(PORT, () => console.log(`Walkthrough running on port ${PORT} [${isSandbox ? 'SANDBOX' : 'PRODUCTION'}]`));
}).catch((e) => {
  console.error('Database setup failed:', e);
  process.exit(1);
});
