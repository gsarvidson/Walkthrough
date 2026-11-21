// Storage for Walkthrough.
// With DATABASE_URL set (Render), data lives in Postgres.
// Without it (local testing), an in-memory Postgres (pg-mem) is used and data is lost on restart.

const hasDb = !!process.env.DATABASE_URL;
let pool;

if (hasDb) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
} else {
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  tm_member_id  BIGINT UNIQUE NOT NULL,
  nickname      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS properties (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id      BIGINT NOT NULL,
  title           TEXT,
  address         TEXT,
  suburb          TEXT,
  region          TEXT,
  price           TEXT,
  listing_type    TEXT,
  bedrooms        TEXT,
  bathrooms       TEXT,
  photo_url       TEXT,
  listing_url     TEXT,
  open_homes      JSONB NOT NULL DEFAULT '[]',
  agent           JSONB,
  closes_at       TIMESTAMPTZ,
  on_watchlist    BOOLEAN NOT NULL DEFAULT true,
  first_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS visits (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id    BIGINT NOT NULL,
  kind          TEXT NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id BIGINT NOT NULL,
  room       TEXT NOT NULL DEFAULT 'General',
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rating_categories JSONB
);

CREATE TABLE IF NOT EXISTS ratings (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id BIGINT NOT NULL,
  category   TEXT NOT NULL,
  score      INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, listing_id, category)
);

CREATE TABLE IF NOT EXISTS checklist (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id BIGINT NOT NULL,
  item_key   TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'ask',
  body       TEXT,
  custom     BOOLEAN NOT NULL DEFAULT false,
  done       BOOLEAN NOT NULL DEFAULT false,
  answer     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, listing_id, item_key)
);

CREATE TABLE IF NOT EXISTS feedback (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id      BIGINT NOT NULL,
  interest        TEXT,
  include_ratings JSONB NOT NULL DEFAULT '[]',
  comment         TEXT,
  share_contact   BOOLEAN NOT NULL DEFAULT false,
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  UNIQUE (user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS photos (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id BIGINT NOT NULL,
  room       TEXT NOT NULL DEFAULT 'General',
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const iso = (d) => (d ? new Date(d).toISOString() : null);

function rowToProperty(r) {
  return {
    listingId: Number(r.listing_id),
    title: r.title,
    address: r.address,
    suburb: r.suburb,
    region: r.region,
    price: r.price,
    listingType: r.listing_type,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    photoUrl: r.photo_url,
    listingUrl: r.listing_url,
    openHomes: typeof r.open_homes === 'string' ? JSON.parse(r.open_homes) : (r.open_homes || []),
    agent: typeof r.agent === 'string' ? JSON.parse(r.agent) : (r.agent || null),
    closesAt: iso(r.closes_at),
    firstSyncedAt: iso(r.first_synced_at)
  };
}

async function init() {
  if (!hasDb) console.warn('No DATABASE_URL set: using in-memory database (data is lost on restart).');
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
}

function sessionStore(session) {
  if (!hasDb) return undefined; // default memory store for local testing
  const PgStore = require('connect-pg-simple')(session);
  return new PgStore({ pool, createTableIfMissing: true });
}

// ── users ────────────────────────────────────────────────────────────────────
async function upsertUser(memberId, nickname) {
  const { rows } = await pool.query(
    `INSERT INTO users (tm_member_id, nickname) VALUES ($1, $2)
     ON CONFLICT (tm_member_id) DO UPDATE SET nickname = EXCLUDED.nickname, last_login_at = now()
     RETURNING id`,
    [memberId, nickname]
  );
  return rows[0].id;
}

async function lastSync(userId) {
  const { rows } = await pool.query('SELECT last_sync_at FROM users WHERE id = $1', [userId]);
  return rows[0] ? iso(rows[0].last_sync_at) : null;
}

// ── properties ───────────────────────────────────────────────────────────────
async function saveSync(userId, props) {
  for (const p of props) {
    await pool.query(
      `INSERT INTO properties (user_id, listing_id, title, address, suburb, region, price, listing_type,
         bedrooms, bathrooms, photo_url, listing_url, open_homes, agent, closes_at, on_watchlist, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,now())
       ON CONFLICT (user_id, listing_id) DO UPDATE SET
         title = EXCLUDED.title, address = EXCLUDED.address, suburb = EXCLUDED.suburb, region = EXCLUDED.region,
         price = EXCLUDED.price, listing_type = EXCLUDED.listing_type, bedrooms = EXCLUDED.bedrooms,
         bathrooms = EXCLUDED.bathrooms, photo_url = EXCLUDED.photo_url, listing_url = EXCLUDED.listing_url,
         open_homes = EXCLUDED.open_homes, agent = EXCLUDED.agent, closes_at = EXCLUDED.closes_at,
         on_watchlist = true, last_synced_at = now()`,
      [userId, p.listingId, p.title, p.address, p.suburb, p.region, p.price, p.listingType,
        p.bedrooms, p.bathrooms, p.photoUrl, p.listingUrl, JSON.stringify(p.openHomes),
        p.agent ? JSON.stringify(p.agent) : null, p.closesAt]
    );
  }
  // Anything no longer on the watchlist is hidden (but kept, with its notes and photos).
  const { rows } = await pool.query('SELECT listing_id FROM properties WHERE user_id = $1 AND on_watchlist', [userId]);
  const keep = new Set(props.map((p) => p.listingId));
  for (const r of rows) {
    if (!keep.has(Number(r.listing_id))) {
      await pool.query('UPDATE properties SET on_watchlist = false WHERE user_id = $1 AND listing_id = $2', [userId, r.listing_id]);
    }
  }
  await pool.query('UPDATE users SET last_sync_at = now() WHERE id = $1', [userId]);
}

async function countsFor(userId) {
  const q = async (table, extra = '') => {
    const { rows } = await pool.query(
      `SELECT listing_id, COUNT(*) AS n ${extra} FROM ${table} WHERE user_id = $1 GROUP BY listing_id`, [userId]);
    return rows;
  };
  const out = {};
  const get = (id) => (out[id] = out[id] || { notes: 0, photos: 0, visits: 0, lastVisit: null });
  for (const r of await q('notes')) get(Number(r.listing_id)).notes = Number(r.n);
  for (const r of await q('photos')) get(Number(r.listing_id)).photos = Number(r.n);
  for (const r of await q('visits', ', MAX(checked_in_at) AS last')) {
    const c = get(Number(r.listing_id)); c.visits = Number(r.n); c.lastVisit = iso(r.last);
  }
  return out;
}

async function listProperties(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM properties WHERE user_id = $1 AND on_watchlist ORDER BY first_synced_at DESC', [userId]);
  const counts = await countsFor(userId);
  const ratings = await allRatings(userId);
  const cats = await getCategories(userId);
  const fb = await feedbackStatuses(userId);
  return rows.map((r) => {
    const p = rowToProperty(r);
    p.feedback = fb[Number(r.listing_id)] || null;
    p.counts = counts[p.listingId] || { notes: 0, photos: 0, visits: 0, lastVisit: null };
    const mine = ratings[p.listingId] || {};
    const scores = cats.map((c) => mine[c]).filter((s) => s > 0);
    p.ratings = mine;
    p.average = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
    return p;
  });
}

async function getProperty(userId, listingId) {
  const { rows } = await pool.query('SELECT * FROM properties WHERE user_id = $1 AND listing_id = $2', [userId, listingId]);
  if (!rows[0]) return null;
  const p = rowToProperty(rows[0]);
  p.visits = (await pool.query(
    'SELECT id, kind, checked_in_at FROM visits WHERE user_id = $1 AND listing_id = $2 ORDER BY checked_in_at DESC',
    [userId, listingId])).rows.map((v) => ({ id: v.id, kind: v.kind, checkedInAt: iso(v.checked_in_at) }));
  p.notes = (await pool.query(
    'SELECT id, room, body, created_at FROM notes WHERE user_id = $1 AND listing_id = $2 ORDER BY created_at DESC',
    [userId, listingId])).rows.map((n) => ({ id: n.id, room: n.room, body: n.body, createdAt: iso(n.created_at) }));
  p.photos = (await pool.query(
    'SELECT id, room, created_at FROM photos WHERE user_id = $1 AND listing_id = $2 ORDER BY created_at DESC',
    [userId, listingId])).rows.map((ph) => ({ id: ph.id, room: ph.room, createdAt: iso(ph.created_at) }));
  return p;
}

// ── visits ───────────────────────────────────────────────────────────────────
async function addVisit(userId, listingId, kind) {
  const { rows } = await pool.query(
    'INSERT INTO visits (user_id, listing_id, kind) VALUES ($1, $2, $3) RETURNING id', [userId, listingId, kind]);
  return rows[0].id;
}
async function deleteVisit(userId, id) {
  await pool.query('DELETE FROM visits WHERE user_id = $1 AND id = $2', [userId, id]);
}

// ── notes ────────────────────────────────────────────────────────────────────
async function addNote(userId, listingId, room, body) {
  const { rows } = await pool.query(
    'INSERT INTO notes (user_id, listing_id, room, body) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, listingId, room, body]);
  return rows[0].id;
}
async function deleteNote(userId, id) {
  await pool.query('DELETE FROM notes WHERE user_id = $1 AND id = $2', [userId, id]);
}

// ── photos ───────────────────────────────────────────────────────────────────
async function addPhoto(userId, listingId, room, mime, data) {
  const { rows } = await pool.query(
    'INSERT INTO photos (user_id, listing_id, room, mime, data) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [userId, listingId, room, mime, data]);
  return rows[0].id;
}
async function getPhoto(userId, id) {
  const { rows } = await pool.query('SELECT mime, data FROM photos WHERE user_id = $1 AND id = $2', [userId, id]);
  return rows[0] || null;
}
async function deletePhoto(userId, id) {
  await pool.query('DELETE FROM photos WHERE user_id = $1 AND id = $2', [userId, id]);
}

// ── rating categories (per member) ───────────────────────────────────────────
const { DEFAULT_CATEGORIES } = require('./questions');

async function getCategories(userId) {
  const { rows } = await pool.query('SELECT rating_categories FROM user_settings WHERE user_id = $1', [userId]);
  let c = rows[0] && rows[0].rating_categories;
  if (typeof c === 'string') c = JSON.parse(c);
  return Array.isArray(c) && c.length ? c : DEFAULT_CATEGORIES.slice();
}
async function setCategories(userId, cats) {
  await pool.query(
    `INSERT INTO user_settings (user_id, rating_categories) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET rating_categories = EXCLUDED.rating_categories`,
    [userId, JSON.stringify(cats)]);
}
async function renameCategory(userId, from, to) {
  await pool.query('DELETE FROM ratings WHERE user_id = $1 AND category = $2', [userId, to]);
  await pool.query('UPDATE ratings SET category = $3 WHERE user_id = $1 AND category = $2', [userId, from, to]);
}

// ── ratings ──────────────────────────────────────────────────────────────────
async function setRating(userId, listingId, category, score) {
  if (!score) {
    await pool.query('DELETE FROM ratings WHERE user_id = $1 AND listing_id = $2 AND category = $3', [userId, listingId, category]);
    return;
  }
  await pool.query(
    `INSERT INTO ratings (user_id, listing_id, category, score) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, listing_id, category) DO UPDATE SET score = EXCLUDED.score, updated_at = now()`,
    [userId, listingId, category, score]);
}
async function getRatings(userId, listingId) {
  const { rows } = await pool.query('SELECT category, score FROM ratings WHERE user_id = $1 AND listing_id = $2', [userId, listingId]);
  const out = {};
  for (const r of rows) out[r.category] = Number(r.score);
  return out;
}
async function allRatings(userId) {
  const { rows } = await pool.query('SELECT listing_id, category, score FROM ratings WHERE user_id = $1', [userId]);
  const out = {};
  for (const r of rows) (out[Number(r.listing_id)] = out[Number(r.listing_id)] || {})[r.category] = Number(r.score);
  return out;
}

// ── checklist (questions & checks) ───────────────────────────────────────────
async function getChecklist(userId, listingId) {
  const { rows } = await pool.query(
    'SELECT item_key, kind, body, custom, done, answer FROM checklist WHERE user_id = $1 AND listing_id = $2 ORDER BY id',
    [userId, listingId]);
  return rows.map((r) => ({ key: r.item_key, kind: r.kind, text: r.body, custom: r.custom, done: r.done, answer: r.answer }));
}
async function saveChecklistItem(userId, listingId, key, { kind, text, custom, done, answer }) {
  await pool.query(
    `INSERT INTO checklist (user_id, listing_id, item_key, kind, body, custom, done, answer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, listing_id, item_key) DO UPDATE SET
       done = EXCLUDED.done, answer = EXCLUDED.answer, updated_at = now()`,
    [userId, listingId, key, kind || 'ask', text || null, !!custom, !!done, answer || null]);
}
async function deleteChecklistItem(userId, listingId, key) {
  await pool.query('DELETE FROM checklist WHERE user_id = $1 AND listing_id = $2 AND item_key = $3 AND custom', [userId, listingId, key]);
}

// ── feedback ─────────────────────────────────────────────────────────────────
function rowToFeedback(r) {
  if (!r) return null;
  return {
    interest: r.interest,
    includeRatings: typeof r.include_ratings === 'string' ? JSON.parse(r.include_ratings) : (r.include_ratings || []),
    comment: r.comment || '',
    shareContact: r.share_contact,
    contactName: r.contact_name || '',
    contactEmail: r.contact_email || '',
    contactPhone: r.contact_phone || '',
    status: r.status,
    updatedAt: iso(r.updated_at),
    sentAt: iso(r.sent_at)
  };
}
async function getFeedback(userId, listingId) {
  const { rows } = await pool.query('SELECT * FROM feedback WHERE user_id = $1 AND listing_id = $2', [userId, listingId]);
  return rowToFeedback(rows[0]);
}
async function lastContact(userId) {
  const { rows } = await pool.query(
    `SELECT contact_name, contact_email, contact_phone FROM feedback
     WHERE user_id = $1 AND (contact_name IS NOT NULL OR contact_email IS NOT NULL) ORDER BY updated_at DESC LIMIT 1`, [userId]);
  const r = rows[0];
  return r ? { contactName: r.contact_name || '', contactEmail: r.contact_email || '', contactPhone: r.contact_phone || '' } : null;
}
async function saveFeedback(userId, listingId, f) {
  await pool.query(
    `INSERT INTO feedback (user_id, listing_id, interest, include_ratings, comment, share_contact, contact_name, contact_email, contact_phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, listing_id) DO UPDATE SET
       interest = EXCLUDED.interest, include_ratings = EXCLUDED.include_ratings, comment = EXCLUDED.comment,
       share_contact = EXCLUDED.share_contact, contact_name = EXCLUDED.contact_name,
       contact_email = EXCLUDED.contact_email, contact_phone = EXCLUDED.contact_phone, updated_at = now()`,
    [userId, listingId, f.interest, JSON.stringify(f.includeRatings), f.comment, f.shareContact,
      f.contactName || null, f.contactEmail || null, f.contactPhone || null]);
}
async function feedbackStatuses(userId) {
  const { rows } = await pool.query('SELECT listing_id, status FROM feedback WHERE user_id = $1', [userId]);
  const out = {};
  for (const r of rows) out[Number(r.listing_id)] = r.status;
  return out;
}

module.exports = {
  getFeedback, lastContact, saveFeedback, feedbackStatuses,
  init, sessionStore, upsertUser, lastSync, saveSync, listProperties, getProperty,
  addVisit, deleteVisit, addNote, deleteNote, addPhoto, getPhoto, deletePhoto,
  getCategories, setCategories, renameCategory, setRating, getRatings, allRatings,
  getChecklist, saveChecklistItem, deleteChecklistItem
};
