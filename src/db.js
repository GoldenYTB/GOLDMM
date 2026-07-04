require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  return pool.query(text, params);
}

async function logEvent(tradeId, eventType, actorId, detail) {
  await query(
    `INSERT INTO trade_events (trade_id, event_type, actor_id, detail) VALUES ($1,$2,$3,$4)`,
    [tradeId, eventType, actorId || 'system', detail || null]
  );
}

module.exports = { pool, query, logEvent };
