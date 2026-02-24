# Polymarket Trading Bot — Arbitrage & Copytrading

**Polymarket trading bot** | **Polymarket arbitrage bot** | **Polymarket copytrading bot** — fully automated bot for Polymarket prediction markets. Run a hedged arbitrage strategy or copytrade on 15-minute Up/Down markets with sub-second execution.

This **Polymarket bot** captures guaranteed profit by buying both YES and NO at a combined cost below $1.00, then collects $1.00 when the market resolves. Use it as a **Polymarket arbitrage bot** (hedged risk-free spread) or as a **Polymarket copytrading bot** foundation. Open source, self-hosted, no third-party keys.

## What This Polymarket Bot Does

Every 15 minutes, Polymarket opens binary markets like *"Will BTC go Up or Down?"*. Each market has two tokens — YES and NO — that each resolve to exactly **$1.00** or **$0.00**. This Polymarket trading bot automates buying both sides when prices are favorable.

The bot exploits a simple math fact: if you buy YES at $0.47 and NO at $0.47, you spend **$0.94** total. One side always wins and pays **$1.00**. That's **$0.06 profit per share, risk-free**.

```
Buy 5 YES shares @ $0.47  =  $2.35
Buy 5 NO  shares @ $0.47  =  $2.35
                     Total =  $4.70

Market resolves → winning side pays $1.00 × 5 = $5.00
Profit = $5.00 − $4.70 = $0.30 per cycle (6.4% return in 15 min)
```

The bot runs 24/7, executing this strategy every 15 minutes across multiple markets (BTC, ETH, SOL, XRP). Search terms: *polymarket trading bot*, *polymarket arbitrage bot*, *polymarket copytrading bot*, *polymarket prediction market bot*.

## Features

- **Guaranteed Profit** — Both sides of a binary market are purchased; one always wins
- **Sub-second Execution** — 50ms polling loop with fire-and-forget order placement
- **Smart Entry Timing** — Three independent buy triggers (reversal, depth discount, time-based)
- **Adaptive Polling** — Speeds up to 100ms when opportunities are detected, slows to 2s when idle
- **Dynamic Thresholds** — Automatically adjusts second-side entry based on first-side fill price
- **State Persistence** — Resumes mid-hedge after restarts without losing position tracking
- **Risk Guards** — Max cost cap (sumAvg < $0.99), minimum balance check, stale order cleanup
- **Full Logging** — Every trade, price tick, and decision logged to daily rotating files

## Quick Start

### Prerequisites

- Node.js 18+ with `ts-node`
- A Polygon wallet funded with USDC
- Polymarket API credentials (auto-generated on first run)

### Install

```bash
git clone <repository-url>
cd Polymarket-Arbitrage-Trading-Bot
npm install
```

### Configure

Copy the example environment file and set your private key:

```bash
cp .env.example .env
```

```env
PRIVATE_KEY=your_polygon_wallet_private_key

COPYTRADE_MARKETS=btc
COPYTRADE_THRESHOLD=0.47
COPYTRADE_SHARES=5
MAX_BUYS_PER_SIDE=1
```

### Run

```bash
npm start
```

The bot will:
1. Generate API credentials (first run only)
2. Approve USDC allowances on Polymarket contracts
3. Wait until your wallet has at least $1 USDC available
4. Begin the arbitrage loop

## Configuration Reference

### Core Settings

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | *required* | Polygon wallet private key |
| `COPYTRADE_MARKETS` | `btc` | Markets to trade (comma-separated: `btc,eth,sol,xrp`) |
| `COPYTRADE_THRESHOLD` | `0.47` | Entry price — buy when a token drops below this |
| `COPYTRADE_SHARES` | `5` | Number of shares per buy |
| `MAX_BUYS_PER_SIDE` | `1` | Maximum buys per side per 15m cycle |
| `COPYTRADE_MAX_SUM_AVG` | `0.99` | Max combined avg price (above this = no profit) |
| `COPYTRADE_TICK_SIZE` | `0.01` | Price precision for orders |

### Speed Tuning

| Variable | Default | Description |
|---|---|---|
| `COPYTRADE_POLL_MS` | `50` | Main loop interval (milliseconds) |
| `COPYTRADE_MIN_POLL_MS` | `100` | Fastest adaptive poll rate |
| `COPYTRADE_MAX_POLL_MS` | `2000` | Slowest adaptive poll rate |
| `COPYTRADE_FIRE_AND_FORGET` | `true` | Place orders without waiting for confirmation |
| `COPYTRADE_PRICE_BUFFER` | `0.05` | Cents above midpoint to ensure fill |
| `COPYTRADE_USE_FAK` | `true` | Fill-and-Kill orders for instant execution |

### Entry Triggers

| Variable | Default | Description |
|---|---|---|
| `REVERSAL_DELTA` | `0.02` | Price bounce from bottom to trigger buy |
| `COPYTRADE_DEPTH_BUY_DISCOUNT_PERCENT` | `0.02` | Buy if price drops this % below tracked low |
| `COPYTRADE_SECOND_SIDE_BUFFER` | `0.003` | Buffer for opposite side entry |
| `COPYTRADE_DYNAMIC_THRESHOLD_BOOST` | `0.04` | Extra cents added to second-side threshold |

### Timing

| Variable | Default | Description |
|---|---|---|
| `COPYTRADE_WAIT_FOR_NEXT_MARKET_START` | `false` | Wait for next 15m boundary before starting |
| `COPYTRADE_ORDER_CHECK_DELAY_MS` | `100` | Delay before first order status check |
| `COPYTRADE_ORDER_RETRY_DELAY_MS` | `300` | Delay between order status retries |
| `COPYTRADE_ORDER_MAX_ATTEMPTS` | `2` | Max retries for order confirmation |

## Trading Logic

### The 15-Minute Cycle

```
:00 ──── Market opens ─────────────────────── :15
  │                                              │
  │  Poll midpoint prices every 50ms             │
  │  Wait for YES or NO to drop below $0.47      │
  │                                              │
  │  Token drops → start tracking lowest price   │
  │                                              │
  │  Trigger fires → BUY first side              │
  │  Switch to opposite side                     │
  │  Trigger fires → BUY second side             │
  │                                              │
  │  ✓ Hedge complete — wait for resolution      │
  │                                              │
  :15 ── Market resolves → $1.00 payout ────────
```

### Three Buy Triggers

The bot uses three independent triggers. Whichever fires first executes the buy:

**1. Reversal Detection**
Price dropped to a local minimum, then bounced back up by `REVERSAL_DELTA` ($0.02). This confirms the bottom and buys on the way back up.

**2. Depth Discount**
Price fell more than `DEPTH_BUY_DISCOUNT_PERCENT` (2%) below the tracked low. This catches fast crashes where waiting for a reversal would miss the opportunity.

**3. Time Threshold (second side only)**
After buying one side, if the opposite side stays below its dynamic threshold for 200ms, buy immediately. Prevents missing the second side during slow price movement.

### Second Side Entry

After the first buy, the bot calculates a dynamic threshold for the opposite side:

```
secondSideThreshold = (1 - firstBuyPrice) + dynamicThresholdBoost

Example: Bought YES at $0.47
  → Buy NO when price ≤ 1 - 0.47 + 0.04 = $0.57
```

This ensures the combined cost stays well below $1.00.

### Profit Protection

Before every buy, the bot checks:

```
avgPriceYES + avgPriceNO < COPYTRADE_MAX_SUM_AVG ($0.99)
```

If the combined average would exceed $0.99, the buy is skipped — there's no profit margin left.

## Project Structure

```
├── src/
│   ├── index.ts               # Entry point — startup sequence
│   ├── config/index.ts        # Environment config loader
│   ├── order-builder/
│   │   └── copytrade.ts       # Core arbitrage engine (CopytradeArbBot)
│   ├── providers/
│   │   └── clobclient.ts      # Polymarket CLOB API client
│   ├── security/
│   │   ├── allowance.ts       # USDC approval management
│   │   └── createCredential.ts
│   ├── utils/
│   │   ├── balance.ts         # Wallet balance polling
│   │   ├── holdings.ts        # Token position tracking
│   │   ├── logger.ts          # Colored console logger
│   │   └── console-file.ts    # File logging (daily rotation)
│   └── data/
│       ├── copytrade-state.json  # Persistent hedge state
│       └── token-holding.json    # Token position database
├── .env
├── package.json
└── tsconfig.json
```

## Monitoring

The bot logs every action to both console and daily log files in `logs/`:

```
[INFO]  Starting the bot...
[INFO]  Credentials ready
[INFO]  Approving USDC allowances to Polymarket contracts...
[OK]    Wallet is funded
[INFO]  btc | YES=$0.52 NO=$0.48 — tracking NO (below $0.47)
[INFO]  btc | NO dropped to $0.44 (new low)
[INFO]  btc | REVERSAL triggered: NO bounced $0.02 from low → BUY
[OK]    btc | Bought 5 NO @ $0.46 — switching to YES side
[INFO]  btc | YES=$0.50 — below dynamic threshold $0.58
[OK]    btc | Bought 5 YES @ $0.50 — HEDGE COMPLETE
[INFO]  btc | Cost: $0.96/share — Guaranteed profit: $0.04 × 5 = $0.20
```

## Scripts

| Command | Description |
|---|---|
| `npm start` | Start the arbitrage bot |
| `npm run redeem` | Manually redeem a resolved market |
| `npm run redeem:holdings` | Auto-redeem all resolved positions |
| `npm run balance:log` | Log current wallet balances |

## Keywords (SEO)

Polymarket trading bot · Polymarket arbitrage bot · Polymarket copytrading bot · Polymarket bot · Polymarket prediction market bot · Polymarket automated trading · Polymarket hedge bot · Polymarket CLOB bot · Polygon trading bot · prediction market arbitrage

## Contact

[Telegram](https://t.me/crewsxdev)

---

**Disclaimer**: Trading prediction markets carries risk. Past performance does not guarantee future results. Always trade with funds you can afford to lose.
