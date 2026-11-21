require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { OAuth } = require('oauth');
const db = require('./db');
const { isProperty, mapListing } = require('./listing');

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
    res.json({ properties, lastSync });
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

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
db.init().then(() => {
  app.listen(PORT, () => console.log(`Walkthrough running on port ${PORT} [${isSandbox ? 'SANDBOX' : 'PRODUCTION'}]`));
}).catch((e) => {
  console.error('Database setup failed:', e);
  process.exit(1);
});
