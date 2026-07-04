# GoldMM

Discord crypto middleman/escrow bot. Holds BTC, LTC, ETH, SOL, and USDT (BEP20) in a
per-trade deposit address, requires both parties to agree before releasing or cancelling,
and routes disputes to admin.

## ⚠️ Before you go live

1. **BTC sweep/payout is stubbed, not implemented.** `src/payouts.js` throws for it — it
   needs a UTXO-based transaction built with `bitcoinjs-lib` (select UTXOs at the deposit
   address, estimate fee, sign, broadcast) — the same pattern already implemented for LTC in
   `src/chains/ltc.js`, just pointed at a BTC API (Blockstream) instead of BlockCypher. ETH,
   USDT (BEP20), SOL, and LTC are fully wired and tested. Don't accept real BTC trades until
   this is done.
2. **This bot custodies real private keys server-side.** The `MASTER_MNEMONIC` in your `.env`
   can move every coin ever deposited. Treat your Render/Neon dashboard access like a bank
   vault key: 2FA everywhere, never paste the mnemonic into chat, back it up offline (paper,
   not a screenshot).
3. The confirmation-tracking for ETH/USDT currently treats "balance > 0" as sufficient rather
   than tracking the deposit tx's actual block depth — fine for a first pass, but for larger
   trades you'll want real per-tx confirmation counting to avoid acting on a reorg'd deposit.

## Setup

1. `npm install`
2. Copy `.env.example` → `.env` and fill in:
   - `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` from the Discord Developer Portal
   - `GUILD_ID` (your server ID, for instant command registration while testing)
   - `ADMIN_ROLE_ID` (role allowed to run `/mm admin`)
   - `TICKET_CATEGORY_ID` (category where trade channels get created)
   - `DATABASE_URL` — your Neon Postgres connection string
   - `MASTER_MNEMONIC` — run `node src/gen-mnemonic.js` once, paste the output here, then
     delete it from your terminal scrollback
3. Run the schema against your Neon database: `psql "$DATABASE_URL" -f db/schema.sql`
   (or paste `db/schema.sql` into Neon's SQL editor). If you're upgrading from an earlier
   version of this bot, drop and recreate the `trades` table — the schema changed shape.
4. Register slash commands: `npm run deploy-commands` (this registers `/mm panel` and
   `/mm admin` — run `/mm panel` once in whatever channel you want the "start a trade" panel
   to live in)
5. Fund your hot wallet addresses (index 0 for each coin — print them with a quick script
   using `deriveAddress` from `src/wallets.js`) with a little native gas token (ETH for
   sweeping ETH, BNB for sweeping USDT) so it can pay for sweep/payout transactions.
6. `npm start` locally to test, then deploy to Render as a **Web Service** (the built-in
   Express health endpoint on `/` keeps the free tier from idling it).

## How a trade flows

1. An admin runs `/mm panel` once in a channel — this posts a persistent embed with a coin
   dropdown. Anyone can use it any time, no command needed to start a trade.
2. A user picks a coin from the dropdown, which pops up a form: the other party
   (@mention or user ID), what they're giving, and what the other side is giving
3. Bot creates a private ticket channel for the two of them and posts the deal terms. **Both**
   users tap either **I'm Sending Crypto** or **I'm Receiving Crypto** to self-claim their
   role
4. Once both roles are locked in, the sender taps **Enter Amount (USD)** and types a dollar
   value. Bot converts it to a coin amount at the current price and both parties tap
   **Confirm Amount**
5. Bot generates a unique deposit address for that trade, posts it with a QR code, and a
   **Copy Info** button that drops the exact amount + address into a tap-to-copy code block
   (Discord bots can't push straight to a clipboard — a code block is the closest equivalent
   and works well on mobile: tap and hold to copy)
6. Background poller checks every 30s for the deposit, waits for required confirmations,
   sweeps into the central hot wallet, and calculates the tiered fee
7. Once the sender has received their side of the deal, they tap **Release Funds**. If the
   receiver hasn't submitted a payout address yet, they're prompted for one and the payout
   fires automatically the moment it's in. Cancellation still requires **both** parties to
   agree (prevents either side unilaterally pulling funds back)
8. Either party can tap **Dispute / Scam** at any point. This immediately posts **Admin:
   Release to Receiver** / **Admin: Refund to Sender** buttons, visible to anyone but only
   actionable by your admin role — one tap resolves it and sends the funds, no further
   agreement needed from either party. The same thing is available via
   `/mm admin resolve trade_id:<id> action:<release|refund>` if you'd rather use a command.

Note: release is sender-only by design — the sender is the one who can confirm they actually
got what they paid for, so requiring the receiver's sign-off too would just be friction (of
course they want to be paid). Cancel stays mutual since either side pulling out unilaterally
would defeat the point of escrow. Admin override exists specifically for scam attempts —
either side can flag it and an admin settles it directly.

## Fee tiers (USD value at time of deposit)

- Under $10: free
- $10–$50: 2%
- $50–$100: 3%
- $100+: 5%
