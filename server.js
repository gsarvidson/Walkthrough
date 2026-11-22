require('dotenv').config();
const crypto = require('crypto');
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

// Contact details from the member's Trade Me profile, used to prefill feedback.
function profileFrom(me) {
  return {
    contactName: [me.FirstName, me.LastName].filter(Boolean).join(' ') || me.Nickname || '',
    contactEmail: me.Email || '',
    contactPhone: me.MobilePhoneNumber || me.LandlinePhoneNumber || ''
  };
}
async function getProfile(req) {
  if (req.session.profile) return req.session.profile;
  try {
    req.session.profile = profileFrom(await tmGet(req, 'MyTradeMe/Summary'));
    return req.session.profile;
  } catch (e) {
    return null;
  }
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
      req.session.profile = profileFrom(me);
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
    const g = await giftSummary(req.session.userId);
    res.json({ properties, lastSync, categories, gifts: { points: g.points, goal: g.goal, unlocked: g.unlocked, newPoints: g.newPoints, giftNew: g.giftNew } });
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
  p.feedback = await db.getFeedback(uid, p.listingId);
  p.contactDefaults = p.feedback ? null : ((await db.lastContact(uid)) || (await getProfile(req)));
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

// ── FEEDBACK TO AGENT ────────────────────────────────────────────────────────
// The visitor picks what to share. Sharing creates a private link the agent opens;
// the email/text only carries a short summary plus that link.
const INTERESTS = ['Keen', 'Maybe', 'Not for me'];
const newToken = () => crypto.randomBytes(18).toString('base64url');
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

app.put('/api/properties/:listingId/feedback', requireAuth, wrap(async (req, res) => {
  const uid = req.session.userId;
  const p = await db.getProperty(uid, listingParam(req));
  if (!p) return res.status(404).json({ error: 'Property not found' });
  if (!p.visits.length) return res.status(403).json({ error: 'Tap “I’m here” first – feedback is for homes you’ve viewed.' });

  const b = req.body || {};
  const cats = await db.getCategories(uid);
  const noteIds = new Set(p.notes.map((n) => n.id)), photoIds = new Set(p.photos.map((x) => x.id));
  const f = {
    interest: INTERESTS.includes(b.interest) ? b.interest : null,
    includeNotes: (Array.isArray(b.includeNotes) ? b.includeNotes : []).map(Number).filter((id) => noteIds.has(id)),
    includePhotos: (Array.isArray(b.includePhotos) ? b.includePhotos : []).map(Number).filter((id) => photoIds.has(id)),
    includeRatings: (Array.isArray(b.includeRatings) ? b.includeRatings : []).filter((c) => cats.includes(c)),
    comment: String(b.comment || '').trim().slice(0, 2000),
    shareContact: !!b.shareContact,
    contactName: String(b.contactName || '').trim().slice(0, 100),
    contactEmail: String(b.contactEmail || '').trim().slice(0, 200),
    contactPhone: String(b.contactPhone || '').trim().slice(0, 40)
  };
  if (!f.interest && !f.comment && !f.includeRatings.length && !f.includeNotes.length && !f.includePhotos.length) return res.status(400).json({ error: 'Add at least an interest level, a rating or a comment.' });
  if (f.shareContact && !f.contactName) return res.status(400).json({ error: 'Add your name so the agent knows who it’s from.' });
  if (f.shareContact && f.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.contactEmail)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
  if (f.shareContact && !f.contactEmail && !f.contactPhone) return res.status(400).json({ error: 'Add an email or phone number so the agent can reply.' });
  await db.saveFeedback(uid, p.listingId, f);
  res.json({ feedback: await db.getFeedback(uid, p.listingId) });
}));

// Create (or switch back on) the private link for the agent.
app.post('/api/properties/:listingId/feedback/share', requireAuth, wrap(async (req, res) => {
  const uid = req.session.userId, lid = listingParam(req);
  const token = await db.shareFeedback(uid, lid, newToken());
  if (!token) return res.status(400).json({ error: 'Save your feedback first.' });
  res.json({ url: `${baseUrl(req)}/f/${token}` });
}));

app.post('/api/properties/:listingId/feedback/unshare', requireAuth, wrap(async (req, res) => {
  await db.unshareFeedback(req.session.userId, listingParam(req));
  res.json({ success: true });
}));

// Record how the visitor sent the link (email, text, copy…) – for engagement data.
app.post('/api/properties/:listingId/feedback/sent', requireAuth, wrap(async (req, res) => {
  const via = ['email', 'share', 'copy'].includes(req.body && req.body.via) ? req.body.via : 'other';
  await db.logFeedbackEvent(req.session.userId, listingParam(req), 'sent', via);
  res.json({ success: true });
}));

// ── GIFTS ────────────────────────────────────────────────────────────────────
const gifts = require('./gifts');

async function giftSummary(uid) {
  const history = await db.giftHistory(uid);
  const points = history.filter((h) => h.state === 'confirmed').length;
  let s = await db.getGiftSettings(uid);
  const unlocked = points >= gifts.GOAL;
  if (unlocked && !s.code) { await db.setGiftUnlocked(uid, gifts.makeCode(crypto.randomBytes)); s = await db.getGiftSettings(uid); }
  return {
    points, goal: gifts.GOAL, unlocked,
    newPoints: Math.max(0, points - s.seenPoints),
    giftNew: unlocked && !s.giftSeen,
    history,
    gift: { ...gifts.GIFT, code: unlocked ? s.code : null, unlockedAt: s.unlockedAt }
  };
}

app.get('/api/gifts', requireAuth, wrap(async (req, res) => {
  res.json(await giftSummary(req.session.userId));
}));

// Opening the Gifts tab clears the "+1" / unlocked badges.
app.post('/api/gifts/seen', requireAuth, wrap(async (req, res) => {
  const g = await giftSummary(req.session.userId);
  await db.markGiftsSeen(req.session.userId, g.points, g.unlocked);
  res.json({ success: true });
}));

// ── PUBLIC FEEDBACK PAGE (what the agent sees – no login) ────────────────────
const { renderFeedbackPage, renderGonePage } = require('./feedback-page');

function noIndex(res) {
  res.set('X-Robots-Tag', 'noindex, nofollow').set('Referrer-Policy', 'no-referrer').set('Cache-Control', 'no-store');
}

app.get('/f/:token', wrap(async (req, res) => {
  noIndex(res);
  const f = await db.getFeedbackByToken(String(req.params.token));
  if (!f) return res.status(404).send(renderGonePage());
  const p = await db.getProperty(f.userId, f.listingId);
  if (!p) return res.status(404).send(renderGonePage());
  const isOwner = req.session.userId === f.userId;
  if (!isOwner) await db.logFeedbackEventById(f.id, 'view', (req.get('user-agent') || '').slice(0, 200));
  const ratings = await db.getRatings(f.userId, f.listingId);
  res.send(renderFeedbackPage({ f, p, ratings, isOwner, token: req.params.token }));
}));

app.get('/f/:token/photo/:id', wrap(async (req, res) => {
  noIndex(res);
  const f = await db.getFeedbackByToken(String(req.params.token));
  const id = Number(req.params.id);
  if (!f || !f.includePhotos.includes(id)) return res.status(404).end();
  const ph = await db.getPhoto(f.userId, id);
  if (!ph) return res.status(404).end();
  res.set('Content-Type', ph.mime).send(ph.data);
}));

app.post('/f/:token/confirm', wrap(async (req, res) => {
  noIndex(res);
  const f = await db.getFeedbackByToken(String(req.params.token));
  if (!f) return res.status(404).json({ error: 'This feedback is no longer available.' });
  if (req.session.userId === f.userId) return res.status(403).json({ error: 'Only the agent can confirm attendance.' });
  const attended = !!(req.body && req.body.attended);
  await db.confirmAttendance(f.id, attended);
  await db.logFeedbackEventById(f.id, attended ? 'confirmed' : 'disputed');
  res.json({ success: true, attended });
}));

app.post('/f/:token/reply', wrap(async (req, res) => {
  const f = await db.getFeedbackByToken(String(req.params.token));
  if (f && req.session.userId !== f.userId) await db.logFeedbackEventById(f.id, 'reply', req.body && req.body.via);
  res.json({ success: true });
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

app.patch('/api/notes/:id', requireAuth, wrap(async (req, res) => {
  const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: 'Note is empty' });
  await db.updateNote(req.session.userId, Number(req.params.id), cleanRoom(req.body.room), body);
  res.json({ success: true });
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

app.patch('/api/photos/:id', requireAuth, wrap(async (req, res) => {
  await db.setPhotoRoom(req.session.userId, Number(req.params.id), cleanRoom(req.body && req.body.room));
  res.json({ success: true });
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
