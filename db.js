// Storage for Walkthrough.
// With DATABASE_URL set (Render), data lives in Postgres.
// Without it (local testing), data is kept in memory and lost on restart.

const hasDb = !!process.env.DATABASE_URL;
let pool = null;

if (hasDb) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
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
`;

// ── in-memory fallback ───────────────────────────────────────────────────────
const mem = { users: [], properties: [] };

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
    openHomes: r.open_homes || [],
    agent: r.agent || null,
    closesAt: r.closes_at ? new Date(r.closes_at).toISOString() : null,
    firstSyncedAt: new Date(r.first_synced_at).toISOString()
  };
}

async function init() {
  if (!hasDb) {
    console.warn('No DATABASE_URL set: using in-memory storage (data is lost on restart).');
    return;
  }
  await pool.query(SCHEMA);
}

function sessionStore(session) {
  if (!hasDb) return undefined; // default memory store for local testing
  const PgStore = require('connect-pg-simple')(session);
  return new PgStore({ pool, createTableIfMissing: true });
}

async function upsertUser(memberId, nickname) {
  if (!hasDb) {
    let u = mem.users.find((x) => x.tm_member_id === Number(memberId));
    if (!u) { u = { id: mem.users.length + 1, tm_member_id: Number(memberId), last_sync_at: null }; mem.users.push(u); }
    u.nickname = nickname;
    return u.id;
  }
  const { rows } = await pool.query(
    `INSERT INTO users (tm_member_id, nickname) VALUES ($1, $2)
     ON CONFLICT (tm_member_id) DO UPDATE SET nickname = EXCLUDED.nickname, last_login_at = now()
     RETURNING id`,
    [memberId, nickname]
  );
  return rows[0].id;
}

async function saveSync(userId, props) {
  const ids = props.map((p) => p.listingId);
  if (!hasDb) {
    const now = new Date().toISOString();
    for (const p of props) {
      let r = mem.properties.find((x) => x.user_id === userId && Number(x.listing_id) === p.listingId);
      if (!r) { r = { user_id: userId, listing_id: p.listingId, first_synced_at: now }; mem.properties.push(r); }
      Object.assign(r, {
        title: p.title, address: p.address, suburb: p.suburb, region: p.region, price: p.price,
        listing_type: p.listingType, bedrooms: p.bedrooms, bathrooms: p.bathrooms, photo_url: p.photoUrl,
        listing_url: p.listingUrl, open_homes: p.openHomes, agent: p.agent, closes_at: p.closesAt,
        on_watchlist: true, last_synced_at: now
      });
    }
    mem.properties.filter((x) => x.user_id === userId && !ids.includes(Number(x.listing_id))).forEach((x) => { x.on_watchlist = false; });
    mem.users.find((u) => u.id === userId).last_sync_at = now;
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of props) {
      await client.query(
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
    await client.query(
      `UPDATE properties SET on_watchlist = false WHERE user_id = $1 AND NOT (listing_id = ANY($2::bigint[]))`,
      [userId, ids]
    );
    await client.query('UPDATE users SET last_sync_at = now() WHERE id = $1', [userId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listProperties(userId) {
  if (!hasDb) {
    return mem.properties.filter((x) => x.user_id === userId && x.on_watchlist).map(rowToProperty);
  }
  const { rows } = await pool.query(
    'SELECT * FROM properties WHERE user_id = $1 AND on_watchlist ORDER BY first_synced_at DESC',
    [userId]
  );
  return rows.map(rowToProperty);
}

async function lastSync(userId) {
  if (!hasDb) {
    const u = mem.users.find((x) => x.id === userId);
    return u ? u.last_sync_at : null;
  }
  const { rows } = await pool.query('SELECT last_sync_at FROM users WHERE id = $1', [userId]);
  return rows[0] && rows[0].last_sync_at ? new Date(rows[0].last_sync_at).toISOString() : null;
}

module.exports = { init, sessionStore, upsertUser, saveSync, listProperties, lastSync };
