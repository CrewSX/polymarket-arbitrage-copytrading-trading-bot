# Polymarket Arbitrage Bot · Polymarket Trading Bot · Gabagool Fork

**Polymarket arbitrage bot** and **Polymarket copytrading bot** for automated prediction-market trading. This repo is a **polymarket-arbitrage-gabagool-fork** — a TypeScript **Polymarket trading bot** that trades Polymarket’s 15-minute Up/Down markets (e.g. BTC, ETH) using the CLOB API, WebSocket orderbook, and an adaptive price predictor.

---

## Keywords & topics (for search)

`polymarket` · `polymarket arbitrage bot` · `polymarket trading bot` · `polymarket copytrading bot` · `polymarket-arbitrage-gabagool-fork` · `polymarket prediction market` · `polymarket CLOB` · `polymarket bot` · `gabagool` · `prediction market bot` · `Polymarket API`

---

## What this bot does

Automated **Polymarket** trading on **15-minute Up/Down markets**. It uses a price predictor to choose direction, places a first-side limit at best ask, then hedges with a second-side limit at `0.98 − firstSidePrice`. Built with TypeScript and Polymarket’s CLOB API. Suitable as a **Polymarket arbitrage bot** or **Polymarket copytrading bot** for 15m markets.

## About the developer

If have any questions, contact here:  [Telegram](https://t.me/@crewsxdev).

## Proof of work

Bot logs from live runs: [logs](https://github.com/CrewSX/polymarket-arbitrage-copytrading-trading-bot/tree/main/logs).

### Screenshots (bot in action)

| | |
|---|---|
| ![Bot log 1](./images/log1.png) | ![Bot log 2](./images/log2.png) |
| ![Bot log 3](./images/log3.png) | ![Bot log 4](./images/log4.png) |

---

## Overview

- **Strategy**: Predict Up/Down from live orderbook via an adaptive price predictor; buy the predicted side at best ask (GTC), then place the opposite side at `0.98 − firstSidePrice` (GTC).
- **Markets**: Configurable list (e.g. `btc`, `eth`); slugs are resolved as `{market}-updown-15m-{startOf15mUnix}` via Polymarket Gamma API.
- **Stack**: TypeScript, Node (or Bun), `@polymarket/clob-client`, WebSocket orderbook, Ethers.js for allowances/redemption.

## Requirements

- Node.js 18+ (or Bun)
- Polygon wallet with USDC
- RPC URL for Polygon (e.g. Alchemy) for allowances and redemption

## Install

```bash
git clone https://github.com/XXX/polymarket-arbitrage-copytrading-trading-bot.git
cd polymarket-arbitrage-copytrading-trading-bot
npm install
```

## Configuration

Copy the example env and set at least `PRIVATE_KEY` and `COPYTRADE_MARKETS`:

```bash
cp .env.temp .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVATE_KEY` | Wallet private key | **required** |
| `COPYTRADE_MARKETS` | Comma-separated markets (e.g. `btc`) | `btc` |
| `COPYTRADE_SHARES` | Shares per side per trade | `5` |
| `COPYTRADE_TICK_SIZE` | Price precision | `0.01` |
| `COPYTRADE_PRICE_BUFFER` | Price buffer for execution | `0` |
| `COPYTRADE_WAIT_FOR_NEXT_MARKET_START` | Wait for next 15m boundary before starting | `false` |
| `COPYTRADE_MAX_BUY_COUNTS_PER_SIDE` | Max buys per side per market (0 = no cap) | `0` |
| `CHAIN_ID` | Chain ID (Polygon) | `137` |
| `CLOB_API_URL` | Polymarket CLOB API base URL | `https://clob.polymarket.com` |
| `RPC_URL` / `RPC_TOKEN` | RPC for allowances/redemption | — |
| `BOT_MIN_USDC_BALANCE` | Min USDC to start | `1` |
| `LOG_DIR` / `LOG_FILE_PREFIX` | Log directory and file prefix | `logs` / `bot` |

API credentials are created on first run and stored in `src/data/credential.json`.

## Usage

**Run the Polymarket trading bot**

```bash
npm start
# or: bun src/index.ts
```

**Redemption**

```bash
# Auto-redeem resolved markets (holdings file)
npm run redeem:holdings
# or: bun src/auto-redeem.ts [--dry-run] [--clear-holdings] [--api] [--max N]

# Redeem by condition ID
npm run redeem
# or: bun src/redeem.ts [conditionId] [indexSets...]
bun src/redeem.ts --check <conditionId>
```

**Development**

```bash
npx tsc --noEmit
bun --watch src/index.ts
```

## Project structure

| Path | Role |
|------|------|
| `src/index.ts` | Entry: credentials, CLOB, allowances, min balance, start `CopytradeArbBot`. |
| `src/config/index.ts` | Loads `.env` and exposes config (chain, CLOB, copytrade, logging). |
| `src/order-builder/copytrade.ts` | **CopytradeArbBot**: 15m slug resolution, WebSocket orderbook, predictor → first-side buy + second-side hedge; state in `src/data/copytrade-state.json`. |
| `src/providers/clobclient.ts` | Polymarket CLOB client singleton (credentials + `PRIVATE_KEY`). |
| `src/providers/websocketOrderbook.ts` | WebSocket to Polymarket CLOB market channel; best bid/ask by token ID. |
| `src/utils/pricePredictor.ts` | **AdaptivePricePredictor**: direction, confidence, signal (BUY_UP / BUY_DOWN / HOLD). |
| `src/utils/redeem.ts` | CTF redemption, resolution checks, auto-redeem from holdings or API. |
| `src/security/allowance.ts` | USDC and CTF approvals. |
| `src/data/token-holding.json` | Token holdings for redemption (generated). |
| `src/data/copytrade-state.json` | Per-slug state (prices, timestamps, buy counts). |

## Risk and disclaimer

Trading prediction markets involves significant risk. This software is provided as-is. Use at your own discretion and only with funds you can afford to lose.

## License

ISC
