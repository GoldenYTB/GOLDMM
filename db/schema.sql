-- GoldMM database schema (Postgres / Neon)

CREATE TABLE IF NOT EXISTS trades (
  id                    SERIAL PRIMARY KEY,
  guild_id              TEXT NOT NULL,
  channel_id            TEXT,                    -- ticket channel/thread id
  coin                  TEXT NOT NULL,            -- BTC | LTC | ETH | SOL | USDT_BEP20
  status                TEXT NOT NULL DEFAULT 'setup',
                        -- setup -> awaiting_amount -> pending -> funded -> released | cancelled | disputed

  initiator_id          TEXT NOT NULL,            -- who ran /mm start
  initiator_offer       TEXT,                     -- free text: what the initiator is giving
  counterparty_id       TEXT NOT NULL,             -- the other party, named in /mm start
  counterparty_offer    TEXT,                     -- free text: what the counterparty is giving

  sender_id             TEXT,                     -- locked in once both parties claim roles
  receiver_id           TEXT,

  amount_usd_requested  NUMERIC,                  -- USD value the sender enters
  amount_coin_quoted    NUMERIC,                  -- converted coin amount at quote time
  quote_price_usd       NUMERIC,                  -- coin/USD price used for the quote
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

  released_by            TEXT,                     -- sender releases unilaterally once they've received their side of the deal
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
  event_type  TEXT NOT NULL,     -- created, role_claimed, amount_quoted, amount_confirmed, deposit_seen, swept, released, cancel_agreed, disputed, resolved, etc.
  actor_id    TEXT,              -- discord user id, or 'system' / 'admin'
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_channel ON trades(channel_id);
CREATE INDEX IF NOT EXISTS idx_trade_events_trade ON trade_events(trade_id);
