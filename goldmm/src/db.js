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

// Records every wallet address the bot generates into a standalone audit log, independent
// of the trades table. Safe to call repeatedly for the same (coin, index, purpose) — it
// just leaves the first record in place rather than erroring or duplicating.
async function logWalletAddress(coin, derivationIndex, address, purpose, tradeId = null) {
  await query(
    `INSERT INTO wallet_log (coin, derivation_index, address, purpose, trade_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (coin, derivation_index, purpose) DO NOTHING`,
    [coin, derivationIndex, address, purpose, tradeId]
  );
}

// Runs on every startup. CREATE ... IF NOT EXISTS is idempotent and safe to run every
// time, so the bot never again depends on someone remembering to paste schema.sql into
// Neon by hand — it just makes sure its own tables exist before doing anything else.
async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS trades (
      id                    SERIAL PRIMARY KEY,
      guild_id              TEXT NOT NULL,
      channel_id            TEXT,
      coin                  TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'setup',
      initiator_id          TEXT NOT NULL,
      initiator_offer       TEXT,
      counterparty_id       TEXT NOT NULL,
      counterparty_offer    TEXT,
      sender_id             TEXT,
      receiver_id           TEXT,
      amount_usd_requested  NUMERIC,
      amount_coin_quoted    NUMERIC,
      quote_price_usd       NUMERIC,
      amount_confirmed_sender    BOOLEAN NOT NULL DEFAULT FALSE,
      amount_confirmed_receiver  BOOLEAN NOT NULL DEFAULT FALSE,
      deposit_address       TEXT,
      derivation_index      INTEGER,
      amount_received       NUMERIC,
      usd_value_at_deposit  NUMERIC,
      fee_percent           NUMERIC,
      fee_amount            NUMERIC,
      receiver_payout_address TEXT,
      sender_refund_address  TEXT,
      released_by            TEXT,
      cancel_agreed_sender     BOOLEAN NOT NULL DEFAULT FALSE,
      cancel_agreed_receiver   BOOLEAN NOT NULL DEFAULT FALSE,
      disputed_by            TEXT,
      swept_tx_hash          TEXT,
      payout_tx_hash          TEXT,
      refund_tx_hash          TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      funded_at               TIMESTAMPTZ,
      released_at             TIMESTAMPTZ,
      cancelled_at             TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS trade_events (
      id          SERIAL PRIMARY KEY,
      trade_id    INTEGER NOT NULL REFERENCES trades(id),
      event_type  TEXT NOT NULL,
      actor_id    TEXT,
      detail      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_channel ON trades(channel_id);
    CREATE INDEX IF NOT EXISTS idx_trade_events_trade ON trade_events(trade_id);

    CREATE TABLE IF NOT EXISTS wallet_log (
      id                SERIAL PRIMARY KEY,
      coin              TEXT NOT NULL,
      derivation_index  INTEGER NOT NULL,
      address           TEXT NOT NULL,
      purpose           TEXT NOT NULL,
      trade_id          INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (coin, derivation_index, purpose)
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_log_address ON wallet_log(address);
  `);
  console.log('[db] schema verified/created.');
}

module.exports = { pool, query, logEvent, logWalletAddress, initSchema };
