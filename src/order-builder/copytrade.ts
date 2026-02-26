<<<<<<< HEAD
import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrder } from "@polymarket/clob-client";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { config } from "../config";
import { addHoldings } from "../utils/holdings";
import { WebSocketOrderBook, TokenPrice } from "../providers/websocketOrderbook";
import { AdaptivePricePredictor, PricePrediction } from "../utils/pricePredictor";
// Helper functions for market slug and token IDs
function slugForCurrent15m(market: string): string {
    const now = new Date();
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setMilliseconds(0);
    const m = d.getMinutes();
    const slotMin = Math.floor(m / 15) * 15;
    d.setMinutes(slotMin, 0, 0);
    // Get Unix timestamp in seconds for the start of this 15-minute slot
    const timestamp = Math.floor(d.getTime() / 1000);
    // Format: {market}-updown-15m-{timestamp}
    return `${market}-updown-15m-${timestamp}`;
=======
import fs from "fs";
import { promisify } from "util";
import path from "path";
import { inspect } from "util";
import { ClobClient, OrderType, Side, type CreateOrderOptions, type UserOrder } from "@polymarket/clob-client";
import { logger } from "../utils/logger";
import { addHoldings } from "../utils/holdings";
import { Wallet } from "@ethersproject/wallet";
import { config } from "../config";

type CopytradeStateRow = {
    qtyYES: number; // UP shares
    qtyNO: number; // DOWN shares
    costYES: number; // USDC spent for UP
    costNO: number; // USDC spent for DOWN
    buysCount: number;
    buyCountYES: number; // Number of successful YES buys (for sumAvg calculation)
    buyCountNO: number; // Number of successful NO buys (for sumAvg calculation)
    attemptCountYES: number; // Number of YES buy attempts (successful + failed) - counts towards MAX_BUYS_PER_SIDE
    attemptCountNO: number; // Number of NO buy attempts (successful + failed) - counts towards MAX_BUYS_PER_SIDE
    lastBuySide?: "YES" | "NO"; // Track last successful buy side to enforce alternation
    lastBuyPriceYES?: number; // Actual fill price of last YES buy (for accurate dynamic threshold)
    lastBuyPriceNO?: number; // Actual fill price of last NO buy (for accurate dynamic threshold)
    lastUpdatedIso: string;
    /**
     * Metadata for attribution / PnL logging (optional for backwards compatibility).
     * These fields allow `redeem-holdings` to compute realized PnL per slug/market.
     */
    conditionId?: string;
    slug?: string;
    market?: string;
    /** Outcome indices in Gamma `outcomes` array (0-based). */
    upIdx?: number;
    downIdx?: number;
};

type CopytradeStateFile = Record<string, CopytradeStateRow>;

type HedgedArbConfig = {
    markets: string[]; // e.g. ["btc","eth","sol","xrp"]
    threshold: number; // initial price threshold for entry
    reversalDelta: number; // delta for reversal confirmation (e.g., 0.020)
    reversalDeltaThresholdPercent: number; // Percentage of reversalDelta to use in dynamic threshold (e.g., 0.5 = 50%)
    maxBuysPerSide: number; // max buys per side (e.g., 4)
    sharesPerSide: number; // shares per buy (N)
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    pollMs: number;
    maxSumAvg: number; // Maximum sumAvg to maintain profit (e.g., 0.98)
    // Order matching improvements - SPEED OPTIMIZATIONS
    useFakOrders: boolean; // Use FAK (Fill-and-Kill) for immediate execution
    useIocOrders: boolean; // Use IOC (Immediate-Or-Cancel) for faster fills (deprecated, use FAK instead)
    fireAndForget: boolean; // Don't wait for order confirmation (fire-and-forget)
    priceBuffer: number; // Price buffer in cents (e.g., 0.03 = 3 cents)
    maxOrderAgeMs: number; // Cancel orders older than this
    dynamicPriceBuffer: boolean; // Adjust price buffer based on volatility
    // Depth-based buy: Buy immediately if price drops significantly below threshold
    depthBuyDiscountPercent: number; // Buy if price is X% below tempPrice (e.g., 0.05 = 5% discount)
    // Second side buy: Buffer for immediate buy of second side after first buy
    secondSideBuffer: number; // Buy second side immediately when price <= (1 - firstBuyPrice) - buffer
    secondSideTimeThresholdMs: number; // Buy second side after price has been below dynamic threshold for this duration (ms)
    dynamicThresholdBoost: number; // Add boost to dynamic threshold for more aggressive opposite side buying (e.g., 0.04 = 4 cents)
    // Risk management
    maxDrawdownPercent: number; // Stop if losses exceed this % (0 = disabled)
    minBalanceUsdc: number; // Minimum balance before stopping
    // Performance - SPEED OPTIMIZATIONS
    adaptivePolling: boolean; // Adjust polling frequency based on activity
    minPollMs: number; // Minimum polling interval
    maxPollMs: number; // Maximum polling interval
    // Order confirmation delays (reduced for speed)
    orderCheckInitialDelayMs: number; // Initial delay before checking order
    orderCheckRetryDelayMs: number; // Delay between retries
    orderCheckMaxAttempts: number; // Max order check attempts
    // State management
    cleanupOldStateDays: number; // Clean up state older than N days
};

const NEW_STATE_FILE = "src/data/copytrade-state.json";
const OLD_STATE_FILE = "src/data/gabagool-state.json";
const NEW_KEY_PREFIX = "copytrade:";
const OLD_KEY_PREFIX = "gabagool:";

function statePath(): string {
    return path.resolve(process.cwd(), NEW_STATE_FILE);
}

function legacyStatePath(): string {
    return path.resolve(process.cwd(), OLD_STATE_FILE);
}

function emptyRow(): CopytradeStateRow {
    return {
        qtyYES: 0,
        qtyNO: 0,
        costYES: 0,
        costNO: 0,
        buysCount: 0,
        buyCountYES: 0,
        buyCountNO: 0,
        attemptCountYES: 0,
        attemptCountNO: 0,
        lastBuySide: undefined,
        lastUpdatedIso: new Date().toISOString(),
    };
}

function avg(cost: number, qty: number): number {
    return qty > 0 ? cost / qty : 0;
}

function keyForSlug(slug: string): string {
    return `${NEW_KEY_PREFIX}${slug}`;
}

function legacyKeyForSlug(slug: string): string {
    return `${OLD_KEY_PREFIX}${slug}`;
}

function normalizeState(raw: any): CopytradeStateFile {
    // Convert gabagool:* keys -> copytrade:* keys (non-destructive for old file).
    const out: CopytradeStateFile = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v !== "object" || !v) continue;
        const row = v as any;
        const normalized: CopytradeStateRow = {
            qtyYES: Number(row.qtyYES ?? 0),
            qtyNO: Number(row.qtyNO ?? 0),
            costYES: Number(row.costYES ?? 0),
            costNO: Number(row.costNO ?? 0),
            buysCount: Number(row.buysCount ?? 0),
            buyCountYES: Number(row.buyCountYES ?? 0),
            buyCountNO: Number(row.buyCountNO ?? 0),
            attemptCountYES: Number(row.attemptCountYES ?? row.buyCountYES ?? 0), // Fallback to buyCountYES for backwards compatibility
            attemptCountNO: Number(row.attemptCountNO ?? row.buyCountNO ?? 0), // Fallback to buyCountNO for backwards compatibility
            lastBuySide: row.lastBuySide === "YES" || row.lastBuySide === "NO" ? row.lastBuySide : undefined,
            lastUpdatedIso: String(row.lastUpdatedIso ?? new Date().toISOString()),
            conditionId: typeof row.conditionId === "string" ? row.conditionId : undefined,
            slug: typeof row.slug === "string" ? row.slug : undefined,
            market: typeof row.market === "string" ? row.market : undefined,
            upIdx: Number.isFinite(Number(row.upIdx)) ? Number(row.upIdx) : undefined,
            downIdx: Number.isFinite(Number(row.downIdx)) ? Number(row.downIdx) : undefined,
        };
        if (k.startsWith(OLD_KEY_PREFIX)) {
            out[k.replace(OLD_KEY_PREFIX, NEW_KEY_PREFIX)] = normalized;
        } else {
            out[k] = normalized;
        }
    }
    return out;
}

function loadState(): CopytradeStateFile {
    const pNew = statePath();
    try {
        if (fs.existsSync(pNew)) {
            const raw = fs.readFileSync(pNew, "utf8").trim();
            if (!raw) return {};
            return normalizeState(JSON.parse(raw));
        }
    } catch (e) {
        logger.warning(`Failed to read copytrade state: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Fallback: read legacy gabagool state and migrate in-memory.
    const pOld = legacyStatePath();
    try {
        if (!fs.existsSync(pOld)) return {};
        const raw = fs.readFileSync(pOld, "utf8").trim();
        if (!raw) return {};
        const migrated = normalizeState(JSON.parse(raw));
        // Best-effort: write migrated state to the new file so future runs are clean.
        try {
            saveState(migrated);
        } catch {
            // ignore
        }
        return migrated;
    } catch (e) {
        logger.warning(`Failed to read legacy state: ${e instanceof Error ? e.message : String(e)}`);
        return {};
    }
}

// PERFORMANCE OPTIMIZATION: Debounced async state saving to avoid blocking
let saveStateTimer: NodeJS.Timeout | null = null;
let pendingState: CopytradeStateFile | null = null;
const writeFileAsync = promisify(fs.writeFile);
const mkdirAsync = promisify(fs.mkdir);

function saveState(state: CopytradeStateFile): void {
    // Debounce: Only save after 50ms of no changes (batches rapid updates, reduced from 100ms for speed)
    pendingState = state;

    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
    }

    saveStateTimer = setTimeout(async () => {
        if (pendingState) {
            const p = statePath();
            try {
                // Use async operations to avoid blocking (fire and forget)
                await mkdirAsync(path.dirname(p), { recursive: true });
                await writeFileAsync(p, JSON.stringify(pendingState, null, 2), "utf8");
            } catch (e) {
                // Only log errors, don't block execution
                logger.warning(`Failed to write copytrade state: ${e instanceof Error ? e.message : String(e)}`);
            }
            pendingState = null;
        }
        saveStateTimer = null;
    }, 50); // 50ms debounce - batches rapid state changes (reduced for speed)
}

function slugForCurrent15m(market: string): string {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(Math.floor(d.getMinutes() / 15) * 15);
    return `${market}-updown-15m-${Math.floor(d.getTime() / 1000)}`;
>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
}

function parseJsonArray<T>(raw: unknown, ctx: string): T[] {
    if (typeof raw !== "string") throw new Error(`${ctx}: expected JSON string`);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${ctx}: expected JSON array`);
    return parsed as T[];
}

async function fetchTokenIdsForSlug(
    slug: string
): Promise<{ upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number }> {
    const url = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Gamma API ${response.status} ${response.statusText} for slug=${slug}`);
    }

    const data = (await response.json()) as any;
    const outcomes = parseJsonArray<string>(data.outcomes, "data.outcomes");
    const tokenIds = parseJsonArray<string>(data.clobTokenIds, "data.clobTokenIds");
    const conditionId = data.conditionId as string;

    const upIdx = outcomes.indexOf("Up");
    const downIdx = outcomes.indexOf("Down");
    if (upIdx < 0 || downIdx < 0) throw new Error(`Missing Up/Down outcomes for slug=${slug}`);
    if (!tokenIds[upIdx] || !tokenIds[downIdx]) throw new Error(`Missing token ids for slug=${slug}`);

    return { upTokenId: tokenIds[upIdx], downTokenId: tokenIds[downIdx], conditionId, upIdx, downIdx };
}

<<<<<<< HEAD
async function getClobClient() {
    const { getClobClient } = await import("../providers/clobclient");
    return await getClobClient();
}

type SimpleStateRow = {
    previousUpPrice: number | null; // Previous cycle's UP token price
    lastUpdatedIso: string;
    // Holdings tracking (for redemption)
    conditionId?: string;
    slug?: string;
    market?: string;
    upIdx?: number;
    downIdx?: number;
};

type SimpleStateFile = Record<string, SimpleStateRow>;

type SimpleConfig = {
    markets: string[]; // e.g. ["btc","eth","sol","xrp"]
    sharesPerSide: number; // shares required per side (e.g., 5)
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    priceBuffer: number; // Price buffer in cents for order execution (e.g., 0.03 = 3 cents)
    fireAndForget: boolean; // Don't wait for order confirmation (fire-and-forget)
    // Risk management
    minBalanceUsdc: number; // Minimum balance before stopping
};

const STATE_FILE = "src/data/copytrade-state.json";

function statePath(): string {
    return path.resolve(process.cwd(), STATE_FILE);
}

function emptyRow(): SimpleStateRow {
    return {
        previousUpPrice: null,
        lastUpdatedIso: new Date().toISOString(),
    };
}

function loadState(): SimpleStateFile {
    const p = statePath();
    try {
        if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, "utf8").trim();
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            // Normalize state
            const normalized: SimpleStateFile = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v !== "object" || !v) continue;
                const row = v as any;
                normalized[k] = {
                    previousUpPrice: typeof row.previousUpPrice === "number" ? row.previousUpPrice : null,
                    lastUpdatedIso: String(row.lastUpdatedIso ?? new Date().toISOString()),
                    conditionId: typeof row.conditionId === "string" ? row.conditionId : undefined,
                    slug: typeof row.slug === "string" ? row.slug : undefined,
                    market: typeof row.market === "string" ? row.market : undefined,
                    upIdx: Number.isFinite(Number(row.upIdx)) ? Number(row.upIdx) : undefined,
                    downIdx: Number.isFinite(Number(row.downIdx)) ? Number(row.downIdx) : undefined,
                };
            }
            return normalized;
        }
    } catch (e) {
        logger.error(`Failed to read state: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {};
}

// Debounced state save
let saveStateTimer: NodeJS.Timeout | null = null;
function saveState(state: SimpleStateFile): void {
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
    }
    saveStateTimer = setTimeout(() => {
        try {
            const p = statePath();
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(state, null, 2));
        } catch (e) {
            logger.error(`Failed to save state: ${e instanceof Error ? e.message : String(e)}`);
        }
        saveStateTimer = null;
    }, 500); // Debounce saves by 500ms
}

export class CopytradeArbBot {
    private lastSlugByMarket: Record<string, string> = {};
=======
function roundDownToTick(price: number, tickSize: CreateOrderOptions["tickSize"]): number {
    const tick = Number(tickSize || "0.01");
    if (!Number.isFinite(tick) || tick <= 0) return price;
    return Math.floor(price / tick) * tick;
}

type DynamicTrackingState = {
    trackingToken: "YES" | "NO" | null; // Which token we're currently tracking
    tempPrice: number; // Lowest price seen for the tracking token
    initialized: boolean; // Whether we've started tracking
    lastFailedBuyAttempt: number; // Timestamp of last failed buy to prevent spam
    isNewHedge: boolean; // True if this is a new hedge (after previous hedge completed)
    firstBuyOfHedge: boolean; // True if we haven't made the first buy of this hedge yet
    secondSideTimerSessionStart: number | null; // Start time of current timer session (null when paused/reset)
    secondSideTimerAccumulated: number; // Accumulated time in milliseconds (persists through pauses)
};

type BotMetrics = {
    totalOrders: number;
    successfulOrders: number;
    failedOrders: number;
    totalSpent: number;
    totalReceived: number;
    avgSumAvg: number;
    sumAvgSamples: number;
    lastBalanceCheck: number;
    lastBalance: number;
    startTime: number;
    errors: number;
    apiErrors: number;
};

export class CopytradeArbBot {
    private lastSlugByMarket: Record<string, string> = {};
    private hedgedLoggedSlugs = new Set<string>();
    private safetyCheckLoggedSlugs = new Set<string>(); // Track slugs that have logged safety check warnings
    private hedgeResetLoggedSlugs = new Set<string>(); // Track slugs that have logged hedge reset message
    private flexibleEntryLoggedSlugs = new Set<string>(); // Track slugs that have logged flexible entry message
    private runningByMarket: Record<string, boolean> = {};
>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
    private tokenIdsByMarket: Record<
        string,
        { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number }
    > = {};
<<<<<<< HEAD
    private state: SimpleStateFile = loadState();
    private isStopped: boolean = false;
    private wsOrderBook: WebSocketOrderBook | null = null;
    private useWebSocket: boolean = true; // Toggle to use WebSocket or API
    private slugCache: Map<string, { slug: string; timestamp: number }> = new Map(); // Cache slug calculations
    private lastProcessedPrice: Map<string, number> = new Map(); // Track last processed price per market
    private pricePredictors: Map<string, AdaptivePricePredictor> = new Map(); // Price predictors per market
    private lastPredictions: Map<string, { prediction: PricePrediction; actualPrice: number; timestamp: number }> = new Map(); // Track predictions for accuracy
    private marketStartTimeBySlug: Map<string, number> = new Map(); // Track when each market slug started

    // Limit order second side strategy tracking
    private tokenCountsByMarket: Map<string, { upTokenCount: number; downTokenCount: number }> = new Map(); // Track token counts per market
    private pausedMarkets: Set<string> = new Set(); // Track paused markets (reached max tokens per side)
    private readonly MAX_BUY_COUNTS_PER_SIDE: number; // Maximum buy counts per side per market (from config)

    // Prediction scoring system
    private predictionScores: Map<string, {
        market: string;
        slug: string;
        startTime: number;
        endTime: number | null;
        upTokenCost: number; // Total cost of UP token purchases
        downTokenCost: number; // Total cost of DOWN token purchases
        upTokenCount: number; // Number of UP token purchases
        downTokenCount: number; // Number of DOWN token purchases
        totalPredictions: number;
        correctPredictions: number;
        trades: Array<{
            prediction: "up" | "down";
            predictedPrice: number;
            actualPrice: number;
            buyToken: "UP" | "DOWN";
            buyPrice: number;
            buyCost: number;
            timestamp: number;
            wasCorrect: boolean | null; // null = not evaluated yet
        }>;
        // Removed: lastBuyToken tracking - no longer alternating between sides
    }> = new Map();

    private initializationPromise: Promise<void> | null = null;

    constructor(private client: ClobClient, private cfg: SimpleConfig) {
        // Initialize MAX_BUY_COUNTS_PER_SIDE from config
        this.MAX_BUY_COUNTS_PER_SIDE = config.copytrade.maxBuyCountsPerSide;
        // Initialize WebSocket orderbook (store promise for later awaiting)
        this.initializationPromise = this.initializeWebSocket();
    }

    static async fromEnv(client: ClobClient): Promise<CopytradeArbBot> {
        const {
            markets, sharesPerSide, tickSize, negRisk,
            priceBuffer, fireAndForget, minBalanceUsdc
        } = config.copytrade;
        const bot = new CopytradeArbBot(client, {
            markets, sharesPerSide, tickSize: tickSize as CreateOrderOptions["tickSize"],
            negRisk, priceBuffer, fireAndForget, minBalanceUsdc,
        });
        await bot.initializationPromise; // Await WebSocket initialization
        return bot;
    }

    async initializeWebSocket(): Promise<void> {
        if (!this.useWebSocket) {
            logger.error("WebSocket disabled in config");
            return;
        }
        try {
            this.wsOrderBook = new WebSocketOrderBook("market", [], null);
            await this.wsOrderBook.connect();
            logger.info("WebSocket orderbook initialized");
        } catch (e) {
            logger.error(`Failed to initialize WebSocket: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }
    }

    async start(): Promise<void> {
        if (this.isStopped) {
            logger.error("Bot is stopped, cannot start");
            return;
        }

        if (!this.wsOrderBook) {
            logger.error("Fatal error: WebSocket orderbook not initialized - cannot start bot");
            return;
        }

        logger.info(`Starting CopytradeArbBot for markets: ${this.cfg.markets.join(", ")}`);
        await this.initializeMarkets();

        // Set up periodic summary generation - only at quarter-hour boundaries (0m, 15m, 30m, 45m)
        // Check every minute to catch quarter-hour boundaries precisely
        setInterval(() => {
            const now = new Date();
            const minutes = now.getMinutes();
            const seconds = now.getSeconds();

            // Only generate summaries at quarter-hour boundaries (0m, 15m, 30m, 45m)
            // Check within the first 5 seconds of the minute to avoid duplicates
            if ((minutes === 0 || minutes === 15 || minutes === 30 || minutes === 45) && seconds < 5) {
                this.generateAllPredictionSummaries();
            }
        }, 60 * 1000); // Check every minute

        // Set up periodic market cycle check (every 10 seconds to catch quarter-hour boundaries)
        // This ensures we detect market cycle changes even if there are no price updates
        setInterval(() => {
            this.checkAndHandleMarketCycleChanges();
        }, 10 * 1000); // Check every 10 seconds
    }

    stop(): void {
        this.isStopped = true;

        // Generate summaries for all active markets before stopping
        logger.info("\n🛑 Generating final prediction summaries...");
        this.generateAllPredictionSummaries();

        if (this.wsOrderBook) {
            this.wsOrderBook.disconnect();
        }
        logger.info("CopytradeArbBot stopped");
    }

    private async initializeMarkets(): Promise<void> {
        for (const market of this.cfg.markets) {
            await this.initializeMarket(market);
        }
    }

    private async initializeMarket(market: string): Promise<void> {
        try {
            const slug = slugForCurrent15m(market);
            logger.info(`Initializing market ${market} with slug ${slug}`);
            const tokenIds = await fetchTokenIdsForSlug(slug);
            this.tokenIdsByMarket[market] = { slug, ...tokenIds };
            this.lastSlugByMarket[market] = slug;

            // Subscribe to WebSocket prices for these tokens
            if (this.wsOrderBook) {
                this.wsOrderBook.subscribeToTokenIds([tokenIds.upTokenId, tokenIds.downTokenId]);

                // Set token labels for logging
                this.wsOrderBook.setTokenLabel(tokenIds.upTokenId, "Up");
                this.wsOrderBook.setTokenLabel(tokenIds.downTokenId, "Down");

                // Set up price update callbacks - trigger trading logic on price updates
                this.wsOrderBook.onPriceUpdate(tokenIds.upTokenId, (tokenId, price) => {
                    void this.handlePriceUpdate(market, { slug, ...tokenIds }, price, "YES");
                });

                this.wsOrderBook.onPriceUpdate(tokenIds.downTokenId, (tokenId, price) => {
                    void this.handlePriceUpdate(market, { slug, ...tokenIds }, price, "NO");
                });
            }
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            const slug = slugForCurrent15m(market);
            logger.error(`⚠️  Market ${market} not available yet (${slug}): ${errorMsg}. Will retry on next price update.`);
            // Don't throw - allow the bot to continue and retry later
=======
    /**
     * Shared in-memory state (persisted to disk). This avoids cross-market races
     * when multiple markets run concurrently and each updates a different key.
     */
    private state: CopytradeStateFile = loadState();

    /**
     * Dynamic tracking state per slug (not persisted - resets on bot restart).
     * Maps slug -> tracking state
     */
    private trackingBySlug: Record<string, DynamicTrackingState> = {};

    /**
     * Track processed orderIDs to prevent duplicate processing
     * Maps orderID -> timestamp
     */
    private processedOrders = new Map<string, number>();

    /**
     * Track open orders for cancellation of stale orders
     * Maps orderID -> { timestamp, market, slug }
     */
    private openOrders = new Map<string, { timestamp: number; market: string; slug: string; leg: "YES" | "NO" }>();

    /**
     * Track last opportunity detection time for aggressive polling
     */
    private lastOpportunityTime: number = 0;

    /**
     * Bot metrics for monitoring
     */
    private metrics: BotMetrics = {
        totalOrders: 0,
        successfulOrders: 0,
        failedOrders: 0,
        totalSpent: 0,
        totalReceived: 0,
        avgSumAvg: 0,
        sumAvgSamples: 0,
        lastBalanceCheck: 0,
        lastBalance: 0,
        startTime: Date.now(),
        errors: 0,
        apiErrors: 0,
    };

    /**
     * Track initial balance for drawdown calculation
     */
    private initialBalance: number = 0;
    private isStopped: boolean = false;

    constructor(private client: ClobClient, private cfg: HedgedArbConfig) {
        // Validate configuration on startup
        this.validateConfig();
        // Clean up old state
        this.cleanupOldState();
    }

    /**
     * Validate configuration and warn about potential issues
     */
    private validateConfig(): void {
        const warnings: string[] = [];

        if (this.cfg.maxSumAvg >= 1.0) {
            warnings.push(`⚠️ COPYTRADE_MAX_SUM_AVG (${this.cfg.maxSumAvg}) is >= 1.0, which means no profitable trades will be allowed!`);
        }

        if (this.cfg.maxSumAvg < 0.9) {
            warnings.push(`⚠️ COPYTRADE_MAX_SUM_AVG (${this.cfg.maxSumAvg}) is very low, may skip many trades`);
        }

        if (this.cfg.sharesPerSide < 1) {
            warnings.push(`⚠️ COPYTRADE_SHARES (${this.cfg.sharesPerSide}) is less than 1`);
        }

        if (this.cfg.minBalanceUsdc < 1) {
            warnings.push(`⚠️ COPYTRADE_MIN_BALANCE_USDC (${this.cfg.minBalanceUsdc}) is less than $1, may cause issues`);
        }

        if (this.cfg.maxDrawdownPercent > 0 && this.cfg.maxDrawdownPercent > 100) {
            warnings.push(`⚠️ COPYTRADE_MAX_DRAWDOWN_PERCENT (${this.cfg.maxDrawdownPercent}) is > 100%`);
        }

        if (this.cfg.minPollMs >= this.cfg.maxPollMs) {
            warnings.push(`⚠️ COPYTRADE_MIN_POLL_MS (${this.cfg.minPollMs}) >= COPYTRADE_MAX_POLL_MS (${this.cfg.maxPollMs})`);
        }

        if (warnings.length > 0) {
            logger.warning("═══════════════════════════════════════");
            logger.warning("⚠️  CONFIGURATION WARNINGS");
            logger.warning("═══════════════════════════════════════");
            warnings.forEach(w => logger.warning(w));
            logger.warning("═══════════════════════════════════════");
>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
        }
    }

    /**
<<<<<<< HEAD
     * Handle price updates from WebSocket - core trading logic
     * Uses queueMicrotask to prevent blocking WebSocket message loop
     */
    private async handlePriceUpdate(
        market: string,
        tokenIds: { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        price: TokenPrice,
        leg: "YES" | "NO"
    ): Promise<void> {
        if (this.isStopped) return;
        if (!price.bestAsk || !Number.isFinite(price.bestAsk)) return; // Use bestAsk

        // Defer heavy processing to prevent blocking WebSocket message loop
        queueMicrotask(async () => {
            // Get slug for current 15m cycle (with caching)
            const slug = this.getSlugForMarket(market);
            if (!slug) {
                // Market not initialized yet - initialize it
                void this.initializeMarket(market);
                return;
            }

            // Check if we have cached tokenIds for this market, and if slug matches
            let currentTokenIds = tokenIds;
            const cachedTokenIds = this.tokenIdsByMarket[market];
            if (cachedTokenIds && cachedTokenIds.slug === slug) {
                // Use cached tokenIds if slug matches
                currentTokenIds = cachedTokenIds;
            }
            // If slug doesn't match, we'll handle re-initialization in the market cycle check below

            // Get both prices (we need UP ask price for comparison) - fast cache lookup
            const upPrice = this.wsOrderBook?.getPrice(currentTokenIds.upTokenId);
            const downPrice = this.wsOrderBook?.getPrice(currentTokenIds.downTokenId);

            // Use bestAsk price for limit orders (required for order placement)
            if (!upPrice?.bestAsk || !downPrice?.bestAsk ||
                !Number.isFinite(upPrice.bestAsk) || !Number.isFinite(downPrice.bestAsk)) {
                return; // Wait for both ask prices
            }

            let upAsk = upPrice.bestAsk;
            let downAsk = downPrice.bestAsk;

            // Debounce: Only process if ask price changed significantly (avoid processing every tick)
            const lastPrice = this.lastProcessedPrice.get(market);
            const minPriceChange = 0.0001; // Minimum change to trigger processing
            if (lastPrice !== undefined && Math.abs(upAsk - lastPrice) < minPriceChange) {
                return; // Price change too small, skip processing
            }
            this.lastProcessedPrice.set(market, upAsk);

            // Get state (fast lookup)
            const state = this.state;
            const k = slug;
            const row = state[k] ?? emptyRow();
            state[k] = row;

            // Check for market cycle change (new 15m period)
            // Initialize lastSlugByMarket if not set (first time)
            if (!this.lastSlugByMarket[market]) {
                this.lastSlugByMarket[market] = slug;
            }

            const prevSlug = this.lastSlugByMarket[market];
            if (prevSlug && prevSlug !== slug) {
                logger.info(`🔄 New market cycle detected for ${market}: ${prevSlug} → ${slug}`);

                // Generate prediction score summary for previous market
                this.generatePredictionScoreSummary(prevSlug, market);

                // Reset token counts and paused state for previous market
                const prevScoreKey = `${market}-${prevSlug}`;
                this.tokenCountsByMarket.delete(prevScoreKey);
                this.pausedMarkets.delete(prevScoreKey);

                // Re-initialize market with new slug to get new token IDs
                logger.info(`🔄 Re-initializing market ${market} with new slug ${slug}`);
                try {
                    const newTokenIds = await fetchTokenIdsForSlug(slug);
                    this.tokenIdsByMarket[market] = { slug, ...newTokenIds };

                    // Update WebSocket subscriptions for new tokens
                    if (this.wsOrderBook) {
                        // Unsubscribe from old tokens (optional, but clean)
                        // Subscribe to new tokens
                        this.wsOrderBook.subscribeToTokenIds([newTokenIds.upTokenId, newTokenIds.downTokenId]);

                        // Set token labels for logging
                        this.wsOrderBook.setTokenLabel(newTokenIds.upTokenId, "Up");
                        this.wsOrderBook.setTokenLabel(newTokenIds.downTokenId, "Down");

                        // Update callbacks with new token IDs
                        this.wsOrderBook.onPriceUpdate(newTokenIds.upTokenId, (tokenId, price) => {
                            void this.handlePriceUpdate(market, { slug, ...newTokenIds }, price, "YES");
                        });

                        this.wsOrderBook.onPriceUpdate(newTokenIds.downTokenId, (tokenId, price) => {
                            void this.handlePriceUpdate(market, { slug, ...newTokenIds }, price, "NO");
                        });
                    }

                    // Update tokenIds for this function call
                    Object.assign(tokenIds, { slug, ...newTokenIds });
                    currentTokenIds = { slug, ...newTokenIds };

                    logger.info(`✅ Market ${market} re-initialized with new token IDs`);
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    logger.error(`⚠️  Failed to re-initialize market ${market} with new slug ${slug}: ${errorMsg}. Will retry on next price update.`);
                    // Don't update lastSlugByMarket if initialization failed - will retry
                    return; // Exit early, will retry on next price update
                }

                this.lastSlugByMarket[market] = slug;
                // Clear slug cache for this market
                this.slugCache.delete(market);
                // Reset price predictor for new market cycle
                const predictor = this.pricePredictors.get(market);
                if (predictor) {
                    predictor.reset();
                }

                // Re-fetch prices with new token IDs after re-initialization
                const newUpPrice = this.wsOrderBook?.getPrice(currentTokenIds.upTokenId);
                const newDownPrice = this.wsOrderBook?.getPrice(currentTokenIds.downTokenId);
                if (!newUpPrice?.bestAsk || !newDownPrice?.bestAsk ||
                    !Number.isFinite(newUpPrice.bestAsk) || !Number.isFinite(newDownPrice.bestAsk)) {
                    // New tokens not ready yet, wait for next price update
                    return;
                }
                // Update prices for rest of function
                upAsk = newUpPrice.bestAsk;
                downAsk = newDownPrice.bestAsk;
            }

            // Update metadata (only if we're going to process)
            row.conditionId = currentTokenIds.conditionId;
            row.slug = slug;
            row.market = market;
            row.upIdx = currentTokenIds.upIdx;
            row.downIdx = currentTokenIds.downIdx;
            row.lastUpdatedIso = new Date().toISOString();

            // Get or create price predictor for this market
            let predictor = this.pricePredictors.get(market);
            if (!predictor) {
                predictor = new AdaptivePricePredictor();
                this.pricePredictors.set(market, predictor);
            }

            // Get prediction for UP token - ONLY returns prediction at pole values, null otherwise
            const prediction = predictor.updateAndPredict(upAsk, Date.now());

            // Only process if we have a prediction (at pole value)
            if (!prediction) {
                // No prediction - price change too small or not at pole, skip
                row.previousUpPrice = upAsk;
                return;
            }

            // Track prediction for accuracy calculation
            const lastPred = this.lastPredictions.get(market);
            if (lastPred) {
                // Calculate if previous prediction was correct
                // Actual direction - use 0.02 threshold (same as noise threshold)
                const priceDiff = upAsk - lastPred.actualPrice;
                // Only consider significant changes (>= 0.02) for direction evaluation
                const actualDirection = Math.abs(priceDiff) >= 0.02
                    ? (priceDiff > 0 ? "up" : "down")
                    : (priceDiff >= 0 ? "up" : "down"); // If change < 0.02, use trend (neutral+up → up)
                const wasCorrect = lastPred.prediction.direction === actualDirection;
                const timeDiff = Date.now() - lastPred.timestamp;

                logger.info(`🔮 Prediction: ${lastPred.prediction.direction.toUpperCase()} (conf: ${lastPred.prediction.confidence.toFixed(2)}) | Actual: ${actualDirection.toUpperCase()} | ${wasCorrect ? "✅ CORRECT" : "❌ WRONG"} | Time: ${timeDiff}ms`);

                // Update prediction score with previous prediction result
                this.updatePredictionScore(market, slug, lastPred.prediction, lastPred.actualPrice, upAsk, wasCorrect);
            }

            // Store current prediction for next evaluation
            this.lastPredictions.set(market, {
                prediction,
                actualPrice: upAsk,
                timestamp: Date.now(),
            });

            // Log prediction details (only at pole values)
            logger.info(`🔮 PREDICT [POLE]: ${prediction.predictedPrice.toFixed(4)} (current: ${upAsk.toFixed(4)}) | Direction: ${prediction.direction.toUpperCase()} | Confidence: ${(prediction.confidence * 100).toFixed(1)}% | Signal: ${prediction.signal} | Momentum: ${prediction.features.momentum.toFixed(3)} | Vol: ${prediction.features.volatility.toFixed(3)} | Trend: ${prediction.features.trend.toFixed(3)}`);

            // Execute prediction-based trading strategy
            this.executePredictionTrade(market, slug, prediction, upAsk, downAsk, currentTokenIds, state, k, row);

            // Log accuracy stats periodically (every 25 predictions, and at milestones)
            const stats = predictor.getAccuracyStats();
            if (stats.totalPredictions > 0) {
                // Log every 25 predictions
                if (stats.totalPredictions % 25 === 0) {
                    logger.info(`📊 Prediction Accuracy: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correctPredictions}/${stats.totalPredictions})`);
                }
                // Also log at key milestones (10, 50, 100, 200, etc.)
                else if ([10, 50, 100, 200, 500, 1000].includes(stats.totalPredictions)) {
                    logger.info(`📊 Prediction Accuracy: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correctPredictions}/${stats.totalPredictions})`);
                }
            }

            // Update previous UP ask price (always update for next comparison)
            row.previousUpPrice = upAsk;
            // State will be saved by debounced saveState automatically
        });
    }

    /**
     * Get slug for current market (always fresh to detect cycle changes)
     */
    private getSlugForMarket(market: string): string | null {
        // Always calculate fresh slug to detect 15-minute cycle changes immediately
        // Don't cache to ensure we always detect new cycles at 0m, 15m, 30m, 45m
        const slug = slugForCurrent15m(market);

        // Update cache for logging/debugging purposes only
        if (slug) {
            this.slugCache.set(market, { slug, timestamp: Date.now() });
        }
        return slug;
    }

    /**
     * Periodically check for market cycle changes and handle them
     * This ensures we detect cycle changes even when there are no price updates
     */
    private async checkAndHandleMarketCycleChanges(): Promise<void> {
        if (this.isStopped) return;

        for (const market of this.cfg.markets) {
            const currentSlug = this.getSlugForMarket(market);
            if (!currentSlug) continue;

            const prevSlug = this.lastSlugByMarket[market];
            if (prevSlug && prevSlug !== currentSlug) {
                logger.info(`🔄 Market cycle change detected via periodic check for ${market}: ${prevSlug} → ${currentSlug}`);

                // Directly re-initialize to avoid duplicate work
                await this.reinitializeMarketForNewCycle(market, prevSlug, currentSlug);
            }
        }
    }

    /**
     * Re-initialize market for a new cycle
     */
    private async reinitializeMarketForNewCycle(market: string, prevSlug: string, newSlug: string): Promise<void> {
        logger.info(`🔄 Re-initializing market ${market} with new slug ${newSlug} (from periodic check)`);

        // Generate prediction score summary for previous market
        this.generatePredictionScoreSummary(prevSlug, market);

        // Reset token counts and paused state for previous market
        const prevScoreKey = `${market}-${prevSlug}`;
        this.tokenCountsByMarket.delete(prevScoreKey);
        this.pausedMarkets.delete(prevScoreKey);

        try {
            const newTokenIds = await fetchTokenIdsForSlug(newSlug);
            this.tokenIdsByMarket[market] = { slug: newSlug, ...newTokenIds };

            // Update WebSocket subscriptions for new tokens
            if (this.wsOrderBook) {
                // Subscribe to new tokens
                this.wsOrderBook.subscribeToTokenIds([newTokenIds.upTokenId, newTokenIds.downTokenId]);

                // Set token labels for logging
                this.wsOrderBook.setTokenLabel(newTokenIds.upTokenId, "Up");
                this.wsOrderBook.setTokenLabel(newTokenIds.downTokenId, "Down");

                // Update callbacks with new token IDs
                this.wsOrderBook.onPriceUpdate(newTokenIds.upTokenId, (tokenId, price) => {
                    void this.handlePriceUpdate(market, { slug: newSlug, ...newTokenIds }, price, "YES");
                });

                this.wsOrderBook.onPriceUpdate(newTokenIds.downTokenId, (tokenId, price) => {
                    void this.handlePriceUpdate(market, { slug: newSlug, ...newTokenIds }, price, "NO");
                });
            }

            this.lastSlugByMarket[market] = newSlug;

            // Clear slug cache for this market
            this.slugCache.delete(market);

            // Reset price predictor for new market cycle
            const predictor = this.pricePredictors.get(market);
            if (predictor) {
                predictor.reset();
            }

            // Track market start time
            const scoreKey = `${market}-${newSlug}`;
            this.marketStartTimeBySlug.set(scoreKey, Date.now());
            logger.info(`✅ Market ${market} re-initialized with new token IDs for cycle ${newSlug}`);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logger.error(`⚠️  Failed to re-initialize market ${market} with new slug ${newSlug}: ${errorMsg}. Will retry on next check.`);
        }
    }

    /**
     * Buy shares with retry logic (optimized for immediate execution)
     */
    private async buySharesWithRetry(
        leg: "YES" | "NO",
        tokenID: string,
        askPrice: number,
        size: number,
        state: SimpleStateFile,
        key: string,
        row: SimpleStateRow,
        market: string,
        slug: string,
        conditionId: string,
        upIdx: number,
        downIdx: number
    ): Promise<boolean> {
        return await this.buyShares(leg, tokenID, askPrice, size, state, key, row, market, slug, conditionId, upIdx, downIdx);
    }

    /**
     * Buy shares (limit order at best ask)
     * Places order immediately (within 10ms) without async delay
     */
    private async buyShares(
        leg: "YES" | "NO",
        tokenID: string,
        askPrice: number,
        size: number,
        state: SimpleStateFile,
        key: string,
        row: SimpleStateRow,
=======
     * Clean up old state entries to keep state file manageable
     */
    private cleanupOldState(): void {
        if (this.cfg.cleanupOldStateDays <= 0) return;

        const cutoffTime = Date.now() - (this.cfg.cleanupOldStateDays * 24 * 60 * 60 * 1000);
        let cleaned = 0;

        for (const [key, row] of Object.entries(this.state)) {
            if (row.lastUpdatedIso) {
                const lastUpdated = new Date(row.lastUpdatedIso).getTime();
                if (lastUpdated < cutoffTime) {
                    delete this.state[key];
                    cleaned++;
                }
            }
        }

        if (cleaned > 0) {
            saveState(this.state);
            logger.info(`🧹 Cleaned up ${cleaned} old state entries (older than ${this.cfg.cleanupOldStateDays} days)`);
        }
    }

    /**
     * Check balance and stop if too low or drawdown exceeded
     */
    private async checkBalanceAndDrawdown(): Promise<boolean> {
        try {
            const { getAvailableBalance } = await import("../utils/balance");
            const { AssetType } = await import("@polymarket/clob-client");

            const available = await getAvailableBalance(this.client, AssetType.COLLATERAL);
            const availableUsdc = available / 10 ** 6;

            this.metrics.lastBalanceCheck = Date.now();
            this.metrics.lastBalance = availableUsdc;

            // Set initial balance on first check
            if (this.initialBalance === 0) {
                this.initialBalance = availableUsdc;
                logger.info(`💰 Initial balance: $${availableUsdc.toFixed(2)}`);
            }

            // Check minimum balance
            if (availableUsdc < this.cfg.minBalanceUsdc) {
                logger.error(`🛑 Balance too low: $${availableUsdc.toFixed(2)} < $${this.cfg.minBalanceUsdc}. Stopping bot.`);
                this.stop();
                return false;
            }

            // Check max drawdown
            if (this.cfg.maxDrawdownPercent > 0 && this.initialBalance > 0) {
                const drawdown = ((this.initialBalance - availableUsdc) / this.initialBalance) * 100;
                if (drawdown > this.cfg.maxDrawdownPercent) {
                    logger.error(`🛑 Max drawdown exceeded: ${drawdown.toFixed(2)}% > ${this.cfg.maxDrawdownPercent}%. Stopping bot.`);
                    this.stop();
                    return false;
                }
            }

            return true;
        } catch (error) {
            this.metrics.errors++;
            logger.warning(`Failed to check balance: ${error instanceof Error ? error.message : String(error)}`);
            return true; // Continue on error
        }
    }

    /**
     * Cancel stale orders that haven't filled
     */
    private async cancelStaleOrders(): Promise<void> {
        if (this.openOrders.size === 0) return;

        const now = Date.now();
        const staleOrders: string[] = [];

        for (const [orderID, orderInfo] of this.openOrders.entries()) {
            if (now - orderInfo.timestamp > this.cfg.maxOrderAgeMs) {
                staleOrders.push(orderID);
            }
        }

        if (staleOrders.length === 0) return;

        logger.info(`🔄 Cancelling ${staleOrders.length} stale order(s)...`);

        for (const orderID of staleOrders) {
            try {
                // Get order first to ensure it exists, then cancel
                const order = await this.client.getOrder(orderID);
                if (order && order.status === "LIVE") {
                    await this.client.cancelOrder({ orderID } as any); // cancelOrder expects OrderPayload
                    this.openOrders.delete(orderID);
                    logger.info(`✅ Cancelled stale order: ${orderID.substring(0, 20)}...`);
                } else {
                    // Order already filled or cancelled, remove from tracking
                    this.openOrders.delete(orderID);
                }
            } catch (error) {
                this.metrics.errors++;
                logger.warning(`Failed to cancel order ${orderID.substring(0, 20)}...: ${error instanceof Error ? error.message : String(error)}`);
                // Remove from tracking even if cancel failed (might already be filled)
                this.openOrders.delete(orderID);
            }
        }
    }

    /**
     * Track order asynchronously without blocking main loop (fire-and-forget mode)
     */
    private trackOrderAsync(
        orderID: string,
        leg: "YES" | "NO",
        tokenID: string,
        conditionId: string,
        size: number,
        limitPrice: number,
        state: CopytradeStateFile,
        key: string,
        market: string,
        slug: string,
        upIdx: number,
        downIdx: number
    ): void {
        // Track order in background without blocking
        void (async () => {
            try {
                const maxAttempts = this.cfg.orderCheckMaxAttempts || 2;
                const retryDelay = this.cfg.orderCheckRetryDelayMs || 300;

                // Wait a bit for order to process
                await new Promise(resolve => setTimeout(resolve, this.cfg.orderCheckInitialDelayMs || 100));

                let order;
                let attempts = 0;

                while (attempts < maxAttempts) {
                    try {
                        order = await this.client.getOrder(orderID);

                        if (order && order.status === "MATCHED") {
                            // Order matched! Update state
                            const row = state[key] ?? emptyRow();
                            
                            // Get filled quantity from order
                            // @ts-ignore - size_matched might not be in type definition but exists at runtime
                            const actualFillSize = parseFloat(order.size_matched || order.original_size || String(size));
                            const tokensReceived = actualFillSize > 0 ? actualFillSize : size;
                            
                            // Calculate USDC spent
                            // Try to get actual amount from order, otherwise use limit price
                            let usdcSpent: number;
                            let actualFillPrice: number;
                            
                            // @ts-ignore - Check for price fields that might exist at runtime
                            if (order.price && parseFloat(order.price) > 0) {
                                // If order has actual fill price, use it
                                actualFillPrice = parseFloat(order.price);
                                usdcSpent = tokensReceived * actualFillPrice;
                            } else {
                                // Fallback: use limit price (less accurate but safe)
                                actualFillPrice = limitPrice;
                                usdcSpent = tokensReceived * limitPrice;
                            }

                            if (tokensReceived > 0) {
                                addHoldings(conditionId, tokenID, tokensReceived);
                            }

                            row.market = market;
                            row.slug = slug;
                            row.conditionId = conditionId;
                            row.upIdx = upIdx;
                            row.downIdx = downIdx;

                            if (leg === "YES") {
                                row.qtyYES += tokensReceived;
                                row.costYES += usdcSpent;
                                row.buyCountYES += 1;
                                row.lastBuySide = "YES";
                                row.lastBuyPriceYES = actualFillPrice; // Store actual fill price for dynamic threshold
                            } else {
                                row.qtyNO += tokensReceived;
                                row.costNO += usdcSpent;
                                row.buyCountNO += 1;
                                row.lastBuySide = "NO";
                                row.lastBuyPriceNO = actualFillPrice; // Store actual fill price for dynamic threshold
                            }
                            row.buysCount += 1;
                            row.lastUpdatedIso = new Date().toISOString();
                            state[key] = row;
                            saveState(state);

                            this.processedOrders.set(orderID, Date.now());
                            this.openOrders.delete(orderID);
                            this.metrics.successfulOrders++;
                            this.metrics.totalSpent += usdcSpent;
                            this.metrics.totalReceived += tokensReceived;

                            const avgYes = avg(row.costYES, row.qtyYES);
                            const avgNo = avg(row.costNO, row.qtyNO);
                            const currentSumAvg = avgYes + avgNo;
                            this.metrics.avgSumAvg += currentSumAvg;
                            this.metrics.sumAvgSamples++;

                            // PERFORMANCE: Only calculate savings info in DEBUG mode
                            let logMsg = `✅ Async order MATCHED: ${orderID.substring(0, 20)}... leg=${leg} filled=${tokensReceived} spent=${usdcSpent.toFixed(6)} sumAvg=${currentSumAvg.toFixed(4)}`;
                            if (config.debug) {
                                const priceDiff = Math.abs(actualFillPrice - limitPrice);
                                if (priceDiff > 0.001) {
                                    logMsg += ` (actual: ${actualFillPrice.toFixed(4)} vs limit: ${limitPrice.toFixed(4)}, saved ${priceDiff.toFixed(4)})`;
                                }
                            }

                            logger.success(logMsg);
                            return;
                        }

                        if (order && order.status === "LIVE" && attempts < maxAttempts - 1) {
                            await new Promise(resolve => setTimeout(resolve, retryDelay));
                            attempts++;
                            continue;
                        }

                        break;
                    } catch (e) {
                        if (attempts < maxAttempts - 1) {
                            await new Promise(resolve => setTimeout(resolve, retryDelay));
                            attempts++;
                            continue;
                        }
                        break;
                    }
                }

                // Order not matched yet or failed - log but don't block
                if (order) {
                    logger.warning(`Async order ${orderID.substring(0, 20)}... status=${order.status} after ${attempts + 1} attempts`);
                } else {
                    logger.warning(`Async order ${orderID.substring(0, 20)}... could not verify after ${attempts + 1} attempts`);
                }
            } catch (error) {
                logger.warning(`Async order tracking failed for ${orderID.substring(0, 20)}...: ${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    }

    /**
     * Stop the bot
     */
    private stop(): void {
        if (this.isStopped) return;
        this.isStopped = true;
        logger.error("🛑 Bot stopped due to safety check");
        this.logMetrics();
    }

    /**
     * Log current metrics
     */
    private logMetrics(): void {
        const successRate = this.metrics.totalOrders > 0
            ? (this.metrics.successfulOrders / this.metrics.totalOrders * 100).toFixed(1)
            : "0.0";
        const uptime = Math.floor((Date.now() - this.metrics.startTime) / 1000);
        const avgSumAvg = this.metrics.sumAvgSamples > 0
            ? (this.metrics.avgSumAvg / this.metrics.sumAvgSamples).toFixed(4)
            : "0.0000";

        logger.info("═══════════════════════════════════════");
        logger.info("📊 BOT METRICS");
        logger.info("═══════════════════════════════════════");
        logger.info(`Total Orders: ${this.metrics.totalOrders}`);
        logger.info(`Successful: ${this.metrics.successfulOrders} (${successRate}%)`);
        logger.info(`Failed: ${this.metrics.failedOrders}`);
        logger.info(`Avg SumAvg: ${avgSumAvg}`);
        logger.info(`Total Spent: $${this.metrics.totalSpent.toFixed(2)}`);
        logger.info(`Current Balance: $${this.metrics.lastBalance.toFixed(2)}`);
        logger.info(`Errors: ${this.metrics.errors} (API: ${this.metrics.apiErrors})`);
        logger.info(`Uptime: ${uptime}s`);
        logger.info("═══════════════════════════════════════");
    }

    static fromEnv(client: ClobClient): CopytradeArbBot {
        const {
            markets, threshold, reversalDelta, reversalDeltaThresholdPercent, maxBuysPerSide, sharesPerSide, tickSize, negRisk, pollMs, maxSumAvg,
            useFakOrders, useIocOrders, fireAndForget, priceBuffer, maxOrderAgeMs, dynamicPriceBuffer,
            depthBuyDiscountPercent, secondSideBuffer, secondSideTimeThresholdMs, dynamicThresholdBoost,
            maxDrawdownPercent, minBalanceUsdc,
            adaptivePolling, minPollMs, maxPollMs,
            orderCheckInitialDelayMs, orderCheckRetryDelayMs, orderCheckMaxAttempts,
            cleanupOldStateDays
        } = config.copytrade;
        return new CopytradeArbBot(client, {
            markets,
            threshold,
            reversalDelta,
            reversalDeltaThresholdPercent,
            maxBuysPerSide,
            sharesPerSide,
            tickSize: tickSize as CreateOrderOptions["tickSize"],
            negRisk,
            pollMs,
            maxSumAvg,
            useFakOrders,
            useIocOrders,
            fireAndForget,
            priceBuffer,
            maxOrderAgeMs,
            dynamicPriceBuffer,
            depthBuyDiscountPercent,
            secondSideBuffer,
            secondSideTimeThresholdMs,
            dynamicThresholdBoost,
            maxDrawdownPercent,
            minBalanceUsdc,
            adaptivePolling,
            minPollMs,
            maxPollMs,
            orderCheckInitialDelayMs,
            orderCheckRetryDelayMs,
            orderCheckMaxAttempts,
            cleanupOldStateDays,
        });
    }

    start(): void {
        // Initial balance check
        void this.checkBalanceAndDrawdown();

        // Cancel stale orders periodically
        setInterval(() => void this.cancelStaleOrders(), 60000); // Every minute

        // Check balance periodically
        setInterval(() => void this.checkBalanceAndDrawdown(), 300000); // Every 5 minutes

        // Log metrics periodically
        setInterval(() => this.logMetrics(), 3600000); // Every hour

        // Start main tick loop
        void this.tick();

        // PERFORMANCE OPTIMIZATION: Use recursive setTimeout for true adaptive polling
        // setInterval doesn't adapt - it uses fixed delay, so we use recursive setTimeout instead
        let currentPollMs = this.cfg.pollMs;

        const scheduleNextTick = () => {
            if (this.isStopped) return;

            // Adjust polling based on activity (true adaptive polling)
            if (this.cfg.adaptivePolling) {
                const activeMarkets = Object.values(this.runningByMarket).filter(Boolean).length;
                const timeSinceLastOpportunity = Date.now() - this.lastOpportunityTime;
                
                // SPEED OPTIMIZATION: Check if any market has active second-side timer
                // If timer is active, poll aggressively to detect threshold crossing faster
                const hasActiveTimer = Object.values(this.trackingBySlug).some(
                    tracking => tracking.secondSideTimerSessionStart !== null
                );

                // SPEED OPTIMIZATION: If opportunity detected recently OR timer is active, poll at minimum
                if (timeSinceLastOpportunity < 5000 || hasActiveTimer) { // Within 5 seconds of opportunity OR timer active
                    currentPollMs = this.cfg.minPollMs; // Poll at minimum (100ms)
                } else if (activeMarkets === 0) {
                    // No active markets, slow down polling
                    currentPollMs = Math.min(this.cfg.maxPollMs, currentPollMs * 1.1);
                } else {
                    // Active markets, speed up polling
                    currentPollMs = Math.max(this.cfg.minPollMs, currentPollMs * 0.9);
                }
            }

            // Execute tick and schedule next one with adaptive delay
            void this.tick().then(() => {
                setTimeout(scheduleNextTick, currentPollMs);
            }).catch(() => {
                // On error, still schedule next tick to keep bot running
                setTimeout(scheduleNextTick, currentPollMs);
            });
        };

        // Start the adaptive polling loop
        setTimeout(scheduleNextTick, currentPollMs);

        logger.info(
            `CopytradeArbBot started markets=${this.cfg.markets.join(",")} pollMs=${this.cfg.pollMs}${this.cfg.adaptivePolling ? " (adaptive)" : ""}`
        );
    }

    async tick(): Promise<void> {
        if (this.isStopped) return;

        // Run each market independently so a slow/hung market doesn't block the others.
        for (const market of this.cfg.markets) {
            if (this.runningByMarket[market]) continue;
            this.runningByMarket[market] = true;
            void this.tickMarketGuarded(market);
        }
    }

    private async tickMarketGuarded(market: string): Promise<void> {
        // Soft "timeout": log if a market takes too long, but don't unlock early (can't safely cancel network/order calls).
        const warnAfterMs = Math.max(30_000, this.cfg.pollMs * 30);
        const startedAt = Date.now();
        const warnTimer = setTimeout(() => {
            logger.warning(
                `Copytrade market tick taking long: market=${market} elapsedMs=${Date.now() - startedAt}`
            );
        }, warnAfterMs);

        try {
            await this.tickMarket(market);
        } catch (e) {
            logger.error(`Copytrade tickMarket failed market=${market}`, e as any);
        } finally {
            clearTimeout(warnTimer);
            this.runningByMarket[market] = false;
        }
    }

    private async tickMarket(market: string): Promise<void> {
        const slug = slugForCurrent15m(market);
        const prevSlug = this.lastSlugByMarket[market];

        // Detect new market cycle
        if (prevSlug && prevSlug !== slug) {
            logger.info(`\n\n==================================================\n`);
            logger.info(`🔄 New 15m market cycle: market=${market} slug=${slug}`);
            // Reset tracking state for new market
            delete this.trackingBySlug[prevSlug];
            // Clear safety check logs for old slug (allow logging again for new market)
            this.safetyCheckLoggedSlugs.delete(prevSlug);
            // Clear hedge reset logs for old slug (allow logging again for new market)
            this.hedgeResetLoggedSlugs.delete(prevSlug);
            // Clear flexible entry logs for old slug (allow logging again for new market)
            this.flexibleEntryLoggedSlugs.delete(prevSlug);
        } else if (!prevSlug) {
            logger.info(`Market cycle initialized: market=${market} slug=${slug}`);
        }
        this.lastSlugByMarket[market] = slug;

        // Cache Gamma token ids per-market per-slug
        const cached = this.tokenIdsByMarket[market];
        const tokenIds =
            cached && cached.slug === slug
                ? cached
                : { slug, ...(await fetchTokenIdsForSlug(slug)) };
        this.tokenIdsByMarket[market] = tokenIds;
        const { upTokenId, downTokenId, conditionId, upIdx, downIdx } = tokenIds;

        // Get current prices
        const [upMidpoint, downMidpoint] = await Promise.all([
            this.client.getMidpoint(upTokenId),
            this.client.getMidpoint(downTokenId),
        ]);
        const upMid = Number(upMidpoint.mid);
        const downMid = Number(downMidpoint.mid);

        // Get state
        const state = this.state;
        const k = keyForSlug(slug);
        const legacyK = legacyKeyForSlug(slug);
        const row = state[k] ?? state[legacyK] ?? emptyRow();

        // Check if max attempts reached for BOTH sides (hedge complete)
        // All attempts (successful + failed) count towards MAX_BUYS_PER_SIDE
        const maxAttemptsReached = row.attemptCountYES >= this.cfg.maxBuysPerSide && row.attemptCountNO >= this.cfg.maxBuysPerSide;
        if (maxAttemptsReached) {
            const avgYes = avg(row.costYES, row.qtyYES);
            const avgNo = avg(row.costNO, row.qtyNO);
            if (!this.hedgedLoggedSlugs.has(slug)) {
                this.hedgedLoggedSlugs.add(slug);
                logger.info(
                    `✅ Hedge complete: market=${market} slug=${slug} attempts=${row.attemptCountYES}Y/${row.attemptCountNO}N successful=${row.buyCountYES}Y/${row.buyCountNO}N avgYES=${avgYes.toFixed(4)} avgNO=${avgNo.toFixed(4)} sumAvg=${(avgYes + avgNo).toFixed(4)}`
                );
            }
            // Reset tracking for new hedge - will start fresh with ENV threshold
            const tracking = this.trackingBySlug[slug];
            if (tracking) {
                tracking.initialized = false;
                tracking.trackingToken = null;
                tracking.tempPrice = 0;
                tracking.isNewHedge = true;
                tracking.firstBuyOfHedge = true;
                tracking.secondSideTimerSessionStart = null; // Reset time tracking
                tracking.secondSideTimerAccumulated = 0;
                // Only log reset message once per hedge completion
                if (!this.hedgeResetLoggedSlugs.has(slug)) {
                    this.hedgeResetLoggedSlugs.add(slug);
                    logger.info(`🔄 Hedge complete, resetting for new hedge (will use ENV threshold=${this.cfg.threshold})`);
                }
            }
            return;
        }

        // Initialize or get tracking state
        let tracking = this.trackingBySlug[slug];
        if (!tracking) {
            tracking = {
                trackingToken: null,
                tempPrice: 0,
                initialized: false,
                lastFailedBuyAttempt: 0,
                isNewHedge: true, // First hedge is always new
                firstBuyOfHedge: true,
                secondSideTimerSessionStart: null,
                secondSideTimerAccumulated: 0
            };
            this.trackingBySlug[slug] = tracking;
        }

        // === NEW STRATEGY: Reset after each hedge ===

        // If this is a new hedge (after previous hedge completed), use ENV threshold
        // Check which token is below threshold and select that one
        if (tracking.isNewHedge && tracking.firstBuyOfHedge) {
            const yesBelow = upMid <= this.cfg.threshold;
            const noBelow = downMid <= this.cfg.threshold;

            if (!yesBelow && !noBelow) {
                // Neither token is below threshold yet, wait
                // PERFORMANCE OPTIMIZATION: Only log when DEBUG enabled
                if (config.debug) {
                    logger.debug(`⏳ Waiting for entry (new hedge): market=${market} YES=${upMid.toFixed(4)} NO=${downMid.toFixed(4)} threshold=${this.cfg.threshold}`);
                }
                return;
            }

            // === HYBRID STRATEGY: Flexible Entry ===
            // After hedge completes, we reset and use ENV threshold for flexible entry
            // Choose whichever token is below threshold (better entry timing)
            // After first buy, we'll enforce strict alternation to maintain hedge balance
            // Priority: Prefer token that matches last buy side (if below threshold), otherwise choose any below threshold
            let selectedToken: "YES" | "NO";
            if (row.lastBuySide === "YES" && yesBelow) {
                selectedToken = "YES";
                logger.info(`🎯 New hedge entry (flexible): Last buy was YES, YES below threshold (${upMid.toFixed(4)} ≤ ${this.cfg.threshold}), starting with YES`);
            } else if (row.lastBuySide === "NO" && noBelow) {
                selectedToken = "NO";
                logger.info(`🎯 New hedge entry (flexible): Last buy was NO, NO below threshold (${downMid.toFixed(4)} ≤ ${this.cfg.threshold}), starting with NO`);
            } else if (yesBelow && noBelow) {
                selectedToken = "YES"; // Default priority if both below
                logger.info(`🎯 New hedge entry (flexible): Both below threshold, starting with YES (priority) price=${upMid.toFixed(4)}`);
            } else if (yesBelow) {
                selectedToken = "YES";
                logger.info(`🎯 New hedge entry (flexible): YES below threshold, starting with YES price=${upMid.toFixed(4)}`);
            } else {
                selectedToken = "NO";
                logger.info(`🎯 New hedge entry (flexible): NO below threshold, starting with NO price=${downMid.toFixed(4)}`);
            }

            tracking.trackingToken = selectedToken;
            tracking.tempPrice = selectedToken === "YES" ? upMid : downMid;
            tracking.initialized = true;
            tracking.isNewHedge = false; // Mark as initialized for this hedge
            // firstBuyOfHedge stays true until first buy succeeds
        } else if (!tracking.initialized) {
            // Legacy initialization (for first hedge or if tracking was lost)
            const yesBelow = upMid <= this.cfg.threshold;
            const noBelow = downMid <= this.cfg.threshold;

            if (!yesBelow && !noBelow) {
                // PERFORMANCE OPTIMIZATION: Only log when DEBUG enabled
                if (config.debug) {
                    logger.debug(`⏳ Waiting for entry: market=${market} YES=${upMid.toFixed(4)} NO=${downMid.toFixed(4)} threshold=${this.cfg.threshold}`);
                }
                return;
            }

            if (yesBelow && noBelow) {
                tracking.trackingToken = "YES";
                tracking.tempPrice = upMid;
                logger.info(`🎯 Entry signal: Both below threshold, tracking YES first (priority) price=${upMid.toFixed(4)}`);
            } else if (yesBelow) {
                tracking.trackingToken = "YES";
                tracking.tempPrice = upMid;
                logger.info(`🎯 Entry signal: YES below threshold, tracking YES price=${upMid.toFixed(4)}`);
            } else {
                tracking.trackingToken = "NO";
                tracking.tempPrice = downMid;
                logger.info(`🎯 Entry signal: NO below threshold, tracking NO price=${downMid.toFixed(4)}`);
            }
            tracking.initialized = true;
            tracking.firstBuyOfHedge = true;
        }

        // Get current token info based on what we're tracking
        const currentToken = tracking.trackingToken!;
        const currentPrice = currentToken === "YES" ? upMid : downMid;
        const currentTokenId = currentToken === "YES" ? upTokenId : downTokenId;
        const attemptCount = currentToken === "YES" ? row.attemptCountYES : row.attemptCountNO;

        // === HYBRID STRATEGY: Flexible Entry + Strict Alternation ===
        // Strategy: After hedge completes, reset and use ENV threshold for flexible entry
        // - First buy of new hedge: Can be whichever token is below ENV threshold (flexible entry)
        // - After first buy: ALWAYS alternate to opposite side (maintains hedging)
        // This gives us: Better entry timing + Maintained hedge balance

        // SAFETY CHECK: Prevent buying same side twice in a row
        // Exception: First buy of new hedge is allowed (flexible entry strategy)
        if (row.lastBuySide === currentToken) {
            if (tracking.firstBuyOfHedge) {
                // First buy of new hedge: Allow flexible entry (can be same side as last hedge's last buy)
                // This enables better entry timing by choosing whichever token is below threshold
                // Only log once per slug to avoid spam
                if (!this.flexibleEntryLoggedSlugs.has(slug)) {
                    this.flexibleEntryLoggedSlugs.add(slug);
                    logger.info(`✅ First buy of new hedge: Allowing ${currentToken} (flexible entry strategy, last buy was also ${currentToken})`);
                }
            } else {
                // After first buy: Enforce strict alternation to maintain hedge balance
                // This prevents sumAvg accumulation and ensures proper hedging
                const oppositeToken = currentToken === "YES" ? "NO" : "YES";
                const oppositePrice = oppositeToken === "YES" ? upMid : downMid;
                const oppositeAttemptCount = oppositeToken === "YES" ? row.attemptCountYES : row.attemptCountNO;

                // Switch to opposite token to continue building hedge
                // The top-level check will stop when BOTH sides reach max attempts
                logger.warning(`⚠️ Safety check: Last buy was ${currentToken}, enforcing alternation - switching to ${oppositeToken}`);
                tracking.trackingToken = oppositeToken;
                tracking.tempPrice = oppositePrice;
                tracking.secondSideTimerSessionStart = null;
                tracking.secondSideTimerAccumulated = 0;
                return;
            }
        }

        // Check if max attempts for current token reached
        // All attempts (successful + failed) count towards MAX_BUYS_PER_SIDE
        if (attemptCount >= this.cfg.maxBuysPerSide) {
            // Current token reached max attempts - switch to opposite if it hasn't reached max
            const oppositeToken = currentToken === "YES" ? "NO" : "YES";
            const oppositePrice = oppositeToken === "YES" ? upMid : downMid;
            const oppositeAttemptCount = oppositeToken === "YES" ? row.attemptCountYES : row.attemptCountNO;

            if (oppositeAttemptCount >= this.cfg.maxBuysPerSide) {
                // Both sides reached max attempts - will be caught by top-level check
                return;
            }

            // Switch to opposite token to continue building hedge
            logger.info(`🔄 ${currentToken} side reached max attempts (${attemptCount}/${this.cfg.maxBuysPerSide}), switching to ${oppositeToken} @ ${oppositePrice.toFixed(4)}`);
            tracking.trackingToken = oppositeToken;
            tracking.tempPrice = oppositePrice;
            tracking.secondSideTimerSessionStart = null;
            tracking.secondSideTimerAccumulated = 0;
            return;
        }

        // Calculate maximum acceptable price for this buy to maintain sumAvg < maxSumAvg
        // Formula: maxPrice = maxSumAvg - currentAvgOtherSide
        // This ensures: currentAvgOtherSide + maxPrice <= maxSumAvg
        const currentAvgYES = avg(row.costYES, row.qtyYES);
        const currentAvgNO = avg(row.costNO, row.qtyNO);
        const currentAvgOtherSide = currentToken === "YES" ? currentAvgNO : currentAvgYES;
        const maxAcceptablePrice = this.cfg.maxSumAvg - currentAvgOtherSide;

        // Track lowest price (always track to catch when price becomes acceptable)
        if (currentPrice < tracking.tempPrice) {
            const isAcceptable = currentPrice <= maxAcceptablePrice;
            tracking.tempPrice = currentPrice;

            // PERFORMANCE OPTIMIZATION: Only log price drops when DEBUG enabled (reduces log spam)
            if (config.debug) {
                if (isAcceptable) {
                    logger.info(
                        `📉 Price DROP: ${currentToken} ${tracking.tempPrice.toFixed(4)} → ${currentPrice.toFixed(4)} ` +
                        `(temp updated ✅, max acceptable: ${maxAcceptablePrice.toFixed(4)}, current sumAvg: ${(currentAvgYES + currentAvgNO).toFixed(4)})`
                    );
                } else {
                    logger.info(
                        `📉 Price DROP but still too high: ${currentToken} ${tracking.tempPrice.toFixed(4)} → ${currentPrice.toFixed(4)} ` +
                        `(temp updated, max acceptable: ${maxAcceptablePrice.toFixed(4)}, waiting for price ≤ ${maxAcceptablePrice.toFixed(4)})`
                    );
                }
            }
            return;
        }

        // Calculate price acceptability for logging/debugging purposes only
        const priceAcceptable = currentPrice <= maxAcceptablePrice;

        // Check if this is the second side (we have a lastBuySide and it's different from currentToken)
        const isSecondSide = row.lastBuySide && row.lastBuySide !== currentToken;

        // === TIME-BASED BUY FOR SECOND SIDE: Continuous Timer Logic ===
        // Timer starts when price enters range: (threshold - COPYTRADE_PRICE_BUFFER) <= price <= threshold
        // - When price > threshold: Reset timer (clear timer)
        // - When price <= threshold: Timer continues counting (continuous, no pause/resume)
        // - Timer resets only if price goes above threshold
        const now = Date.now();
        let timeBelowThreshold = 0;
        let isTimeBasedBuy = false;

        if (isSecondSide) {
            const dynamicThreshold = tracking.tempPrice;
            
            if (currentPrice > dynamicThreshold) {
                // Price is above threshold - RESET timer
                if (tracking.secondSideTimerSessionStart !== null) {
                    tracking.secondSideTimerSessionStart = null;
                    if (config.debug) {
                        logger.debug(`📊 Second side: Price ${currentPrice.toFixed(4)} > threshold ${dynamicThreshold.toFixed(4)}, resetting timer`);
                    }
                }
                timeBelowThreshold = 0;
            } else {
                // Price is at or below threshold - CONTINUOUS timer (no pause/resume)
                if (tracking.secondSideTimerSessionStart === null) {
                    // Start timer when price first goes below threshold
                    tracking.secondSideTimerSessionStart = now;
                    if (config.debug) {
                        logger.debug(`📊 Second side: Price ${currentPrice.toFixed(4)} <= threshold ${dynamicThreshold.toFixed(4)}, starting continuous timer`);
                    }
                }
                // Calculate continuous time (wall-clock time since timer started)
                timeBelowThreshold = now - tracking.secondSideTimerSessionStart;
            }
            
            // Check if time-based trigger should fire
            isTimeBasedBuy = timeBelowThreshold >= this.cfg.secondSideTimeThresholdMs;
        }

        // === DEPTH-BASED BUY: Buy immediately if price drops significantly below threshold ===
        // This prevents missing opportunities when price drops but doesn't reverse
        // Check if current price is significantly below tempPrice (e.g., 5% discount)
        const depthBuyThreshold = tracking.tempPrice * (1 - this.cfg.depthBuyDiscountPercent);
        const isDeepDiscount = currentPrice <= depthBuyThreshold;

        // Check for reversal (price going UP from lowest) - only used for first side or if immediate buy not triggered
        const reversalThreshold = tracking.tempPrice + this.cfg.reversalDelta;
        const isReversal = currentPrice > reversalThreshold;

        // Prevent buy spam: if we recently failed a buy at this temp price, wait for price to drop again
        const recentlyFailed = tracking.lastFailedBuyAttempt > 0 && (now - tracking.lastFailedBuyAttempt) < 5000; // 5 second cooldown

        logger.debug(
            `Tracking ${currentToken}: price=${currentPrice.toFixed(4)} temp=${tracking.tempPrice.toFixed(4)} ` +
            `${isSecondSide ? `[SECOND SIDE] threshold=${tracking.tempPrice.toFixed(4)} time=${timeBelowThreshold}ms/${this.cfg.secondSideTimeThresholdMs}ms ` : ""}` +
            `depth_buy=${depthBuyThreshold.toFixed(4)} (${(this.cfg.depthBuyDiscountPercent * 100).toFixed(1)}% discount) ` +
            `reversal_check=${tracking.tempPrice.toFixed(4)}+${this.cfg.reversalDelta.toFixed(3)}=${reversalThreshold.toFixed(4)} ` +
            `< ${currentPrice.toFixed(4)}? ${isReversal ? "YES ✅" : "NO ❌"} ` +
            `max_acceptable=${maxAcceptablePrice.toFixed(4)} (sumAvg=${(currentAvgYES + currentAvgNO).toFixed(4)}) ` +
            `${priceAcceptable ? "✅" : "❌"}${isTimeBasedBuy ? " ⏱️TIME-BASED BUY" : ""}${isDeepDiscount ? " 💰DEEP DISCOUNT" : ""}${recentlyFailed ? " (cooldown)" : ""}`
        );

        // TIME-BASED BUY FOR SECOND SIDE: Buy when price has been in range for required duration
        if (isTimeBasedBuy && !recentlyFailed) {
            // BUY TRIGGER (Time-Based - Second Side)!
            const opportunityDetectedAt = Date.now();
            // SPEED OPTIMIZATION: Mark opportunity for aggressive polling
            this.lastOpportunityTime = opportunityDetectedAt;
            logger.success(
                `🎯 SECOND BUY (Time-based): ${currentToken} @ ${currentPrice.toFixed(4)} | Price <= threshold ${tracking.tempPrice.toFixed(4)} for ${timeBelowThreshold}ms (>= ${this.cfg.secondSideTimeThresholdMs}ms) ` +
                `attempt_count=${attemptCount + 1}/${this.cfg.maxBuysPerSide}`
            );

            // Get state before buy to check if it succeeded
            const rowBefore = state[k] ?? emptyRow();
            const buyCountBefore = currentToken === "YES" ? rowBefore.buyCountYES : rowBefore.buyCountNO;

            // Execute buy
            const buyStartTime = Date.now();
            const buyPrice = await this.buySharesLimit(
                currentToken,
                currentTokenId,
                currentPrice,
                this.cfg.sharesPerSide,
                state,
                k,
                market,
                slug,
                conditionId,
                upIdx,
                downIdx
            );

            // Check if buy succeeded by comparing buy counts
            const buyTime = Date.now() - buyStartTime;
            const totalExecutionTime = Date.now() - opportunityDetectedAt;
            const rowAfter = state[k] ?? emptyRow();
            const buyCountAfter = currentToken === "YES" ? rowAfter.buyCountYES : rowAfter.buyCountNO;
            const buySucceeded = buyCountAfter > buyCountBefore;

            logger.info(`⏱️ Execution timing: buy=${buyTime}ms total=${totalExecutionTime}ms success=${buySucceeded}`);

            // Reset time tracking after buy attempt
            tracking.secondSideTimerSessionStart = null;
            tracking.secondSideTimerAccumulated = 0;

            // CRITICAL: After any buy (success or fail), ALWAYS switch to opposite token
            const oppositeToken = currentToken === "YES" ? "NO" : "YES";
            const oppositePrice = oppositeToken === "YES" ? upMid : downMid;
            const oppositeBuyCount = oppositeToken === "YES" ? rowAfter.buyCountYES : rowAfter.buyCountNO;

            if (buyPrice !== null) {
                // Calculate dynamic threshold for opposite token (next side)
                // NEW STRATEGY: Formula: 1 - previous token price + boost
                
                // Use actual fill price if available (from async order tracking), otherwise use limit price
                const actualBuyPrice = currentToken === "YES" ? 
                    (rowAfter.lastBuyPriceYES || buyPrice) : 
                    (rowAfter.lastBuyPriceNO || buyPrice);
                
                // Mark that first buy of hedge is complete - now enforce strict alternation
                if (tracking.firstBuyOfHedge) {
                    tracking.firstBuyOfHedge = false;
                    // Clear reset log tracking for this slug - new hedge has started
                    this.hedgeResetLoggedSlugs.delete(slug);
                    logger.success(`🎯 FIRST BUY: ${currentToken} @ ${actualBuyPrice.toFixed(4)} | Hedge started`);
                }
                const dynamicThreshold = 1 - actualBuyPrice + this.cfg.dynamicThresholdBoost; // Add boost for more aggressive buying
                
                if (actualBuyPrice !== buyPrice && config.debug) {
                    logger.debug(`📊 Using actual fill price ${actualBuyPrice.toFixed(4)} (vs limit ${buyPrice.toFixed(4)}) for dynamic threshold`);
                }

                // Ensure threshold meets $1 minimum order requirement
                let estimatedPriceBuffer = 0.01;
                if (this.cfg.dynamicPriceBuffer) {
                    const currentSumAvg = avg(rowAfter.costYES, rowAfter.qtyYES) + avg(rowAfter.costNO, rowAfter.qtyNO);
                    if (currentSumAvg > 0.9) {
                        estimatedPriceBuffer = 0.02;
                    } else if (currentSumAvg > 0.85) {
                        estimatedPriceBuffer = 0.015;
                    }
                }
                const minPriceForOrder = (1.0 / this.cfg.sharesPerSide) - estimatedPriceBuffer;
                const minAcceptableThreshold = Math.max(0, minPriceForOrder);

                // Set tempPrice to the dynamic threshold (will buy immediately when price <= threshold - buffer)
                let calculatedTempPrice = Math.max(minAcceptableThreshold, Math.min(1, dynamicThreshold));

                const wasClampedToMin = dynamicThreshold < minAcceptableThreshold;
                const wasClampedToMax = dynamicThreshold > 1;

                tracking.trackingToken = oppositeToken;
                tracking.tempPrice = calculatedTempPrice;
                tracking.lastFailedBuyAttempt = 0;
                tracking.secondSideTimerSessionStart = null;
                tracking.secondSideTimerAccumulated = 0; // Reset time tracking when switching to new side

                logger.info(`🔄 Switched tracking: ${currentToken} → ${oppositeToken}`);
                // PERFORMANCE OPTIMIZATION: Only log detailed threshold calculation when DEBUG enabled
                if (config.debug) {
                    logger.info(
                        `📊 Dynamic threshold (next side): 1 - ${buyPrice.toFixed(4)} = ${dynamicThreshold.toFixed(4)} ` +
                        `(will buy ${oppositeToken} immediately when price <= ${(dynamicThreshold - this.cfg.secondSideBuffer).toFixed(4)} = ${dynamicThreshold.toFixed(4)} - ${this.cfg.secondSideBuffer.toFixed(4)} buffer)`
                    );
                    if (wasClampedToMin) {
                        const minOrderValue = (calculatedTempPrice + estimatedPriceBuffer) * this.cfg.sharesPerSide;
                        logger.info(
                            `⚠️ Threshold adjusted for $1 minimum order: ${dynamicThreshold.toFixed(4)} → ${calculatedTempPrice.toFixed(4)} ` +
                            `(min threshold: ${minAcceptableThreshold.toFixed(4)} to ensure order value ≥ $1, ` +
                            `estimated order value: $${minOrderValue.toFixed(2)} = (${calculatedTempPrice.toFixed(4)} + ${estimatedPriceBuffer.toFixed(4)}) × ${this.cfg.sharesPerSide})`
                        );
                    } else if (wasClampedToMax) {
                        logger.info(`⚠️ Threshold clamped to max: ${dynamicThreshold.toFixed(4)} → ${calculatedTempPrice.toFixed(4)}`);
                    }
                    logger.info(`🎯 New tracking price for ${oppositeToken}: ${calculatedTempPrice.toFixed(4)} (immediate buy trigger: <= ${(calculatedTempPrice - this.cfg.secondSideBuffer).toFixed(4)})`);
                } else {
                    logger.success(`🎯 DYNAMIC THRESHOLD: ${dynamicThreshold.toFixed(4)} | Will buy ${oppositeToken} when <= ${(dynamicThreshold - this.cfg.secondSideBuffer).toFixed(4)}`);
                }
            }
            if (!buySucceeded) {
                // Buy failed - switch to opposite token
                if (oppositeBuyCount >= this.cfg.maxBuysPerSide) {
                    logger.warning(`⚠️ Buy failed for ${currentToken} and opposite ${oppositeToken} is maxed (${oppositeBuyCount}/${this.cfg.maxBuysPerSide}). Stopping tracking.`);
                    tracking.trackingToken = null;
                    tracking.initialized = false;
                    tracking.secondSideTimerSessionStart = null;
                    tracking.secondSideTimerAccumulated = 0;
                } else {
                    tracking.trackingToken = oppositeToken;
                    // Only set tempPrice to oppositePrice if we didn't already calculate a dynamic threshold
                    // (i.e., if buyPrice was null, meaning no order was placed)
                    if (buyPrice === null) {
                        tracking.tempPrice = oppositePrice;
                    }
                    // If buyPrice !== null, tracking.tempPrice was already set to calculatedTempPrice above, so preserve it
                    tracking.lastFailedBuyAttempt = now;
                    tracking.secondSideTimerSessionStart = null;
                    tracking.secondSideTimerAccumulated = 0;
                    // Note: Not logging "Buy failed" here because in fire-and-forget mode,
                    // buySucceeded check is unreliable (orders are confirmed asynchronously)
                }
            }
            return; // Exit early after time-based buy attempt
        }

        // DEPTH-BASED BUY: Buy immediately if price is significantly below tempPrice
        // This triggers BEFORE reversal check to catch deep discounts immediately
        if (isDeepDiscount && !recentlyFailed) {
            // BUY TRIGGER (Depth-based)!
            const opportunityDetectedAt = Date.now();
            // SPEED OPTIMIZATION: Mark opportunity for aggressive polling
            this.lastOpportunityTime = opportunityDetectedAt;
            const discountPercent = ((tracking.tempPrice - currentPrice) / tracking.tempPrice * 100).toFixed(2);
            logger.success(
                `🎯 SECOND BUY (Depth-based): ${currentToken} @ ${currentPrice.toFixed(4)} | Dropped ${discountPercent}% below tempPrice (${tracking.tempPrice.toFixed(4)} → ${currentPrice.toFixed(4)}, threshold: ${(this.cfg.depthBuyDiscountPercent * 100).toFixed(1)}%) ` +
                `attempt_count=${attemptCount + 1}/${this.cfg.maxBuysPerSide}`
            );

            // Get state before buy to check if it succeeded
            const rowBefore = state[k] ?? emptyRow();
            const buyCountBefore = currentToken === "YES" ? rowBefore.buyCountYES : rowBefore.buyCountNO;

            // Execute buy
            const buyStartTime = Date.now();
            const buyPrice = await this.buySharesLimit(
                currentToken,
                currentTokenId,
                currentPrice,
                this.cfg.sharesPerSide,
                state,
                k,
                market,
                slug,
                conditionId,
                upIdx,
                downIdx
            );

            // Check if buy succeeded by comparing buy counts
            const rowAfter = state[k] ?? emptyRow();
            const buyCountAfter = currentToken === "YES" ? rowAfter.buyCountYES : rowAfter.buyCountNO;
            const buySucceeded = buyCountAfter > buyCountBefore;

            // CRITICAL: After any buy (success or fail), ALWAYS switch to opposite token
            const oppositeToken = currentToken === "YES" ? "NO" : "YES";
            const oppositePrice = oppositeToken === "YES" ? upMid : downMid;
            const oppositeBuyCount = oppositeToken === "YES" ? rowAfter.buyCountYES : rowAfter.buyCountNO;

            if (buyPrice !== null) {
                // Calculate dynamic threshold for opposite token (second side of hedge)
                // NEW STRATEGY: Formula: 1 - previous token price + boost
                // Buy immediately when opposite token price <= (1 - buyPrice + boost) - buffer
                // No waiting for reversal - immediate buy for speed
                
                // Use actual fill price if available (from async order tracking), otherwise use limit price
                const actualBuyPrice = currentToken === "YES" ? 
                    (rowAfter.lastBuyPriceYES || buyPrice) : 
                    (rowAfter.lastBuyPriceNO || buyPrice);
                
                // Mark that first buy of hedge is complete - now enforce strict alternation
                if (tracking.firstBuyOfHedge) {
                    tracking.firstBuyOfHedge = false;
                    // Clear reset log tracking for this slug - new hedge has started
                    this.hedgeResetLoggedSlugs.delete(slug);
                    logger.success(`🎯 FIRST BUY: ${currentToken} @ ${actualBuyPrice.toFixed(4)} | Hedge started`);
                }
                
                const dynamicThreshold = 1 - actualBuyPrice + this.cfg.dynamicThresholdBoost; // Add boost for more aggressive buying
                
                if (actualBuyPrice !== buyPrice && config.debug) {
                    logger.debug(`📊 Using actual fill price ${actualBuyPrice.toFixed(4)} (vs limit ${buyPrice.toFixed(4)}) for dynamic threshold`);
                }

                // Ensure threshold meets $1 minimum order requirement
                let estimatedPriceBuffer = 0.01;
                if (this.cfg.dynamicPriceBuffer) {
                    const currentSumAvg = avg(rowAfter.costYES, rowAfter.qtyYES) + avg(rowAfter.costNO, rowAfter.qtyNO);
                    if (currentSumAvg > 0.9) {
                        estimatedPriceBuffer = 0.02;
                    } else if (currentSumAvg > 0.85) {
                        estimatedPriceBuffer = 0.015;
                    }
                }
                const minPriceForOrder = (1.0 / this.cfg.sharesPerSide) - estimatedPriceBuffer;
                const minAcceptableThreshold = Math.max(0, minPriceForOrder);

                // Set tempPrice to the dynamic threshold (will buy immediately when price <= threshold - buffer)
                let calculatedTempPrice = Math.max(minAcceptableThreshold, Math.min(1, dynamicThreshold));

                const wasClampedToMin = dynamicThreshold < minAcceptableThreshold;
                const wasClampedToMax = dynamicThreshold > 1;

                tracking.trackingToken = oppositeToken;
                tracking.tempPrice = calculatedTempPrice;
                tracking.lastFailedBuyAttempt = 0;
                tracking.secondSideTimerSessionStart = null;
                tracking.secondSideTimerAccumulated = 0; // Reset time tracking when switching to new side

                logger.info(`🔄 Switched tracking: ${currentToken} → ${oppositeToken}`);
                // PERFORMANCE OPTIMIZATION: Only log detailed threshold calculation when DEBUG enabled
                if (config.debug) {
                    logger.info(
                        `📊 Dynamic threshold (second side): 1 - ${buyPrice.toFixed(4)} = ${dynamicThreshold.toFixed(4)} ` +
                        `(will buy ${oppositeToken} immediately when price <= ${(dynamicThreshold - this.cfg.secondSideBuffer).toFixed(4)} = ${dynamicThreshold.toFixed(4)} - ${this.cfg.secondSideBuffer.toFixed(4)} buffer)`
                    );
                    if (wasClampedToMin) {
                        const minOrderValue = (calculatedTempPrice + estimatedPriceBuffer) * this.cfg.sharesPerSide;
                        logger.info(
                            `⚠️ Threshold adjusted for $1 minimum order: ${dynamicThreshold.toFixed(4)} → ${calculatedTempPrice.toFixed(4)} ` +
                            `(min threshold: ${minAcceptableThreshold.toFixed(4)} to ensure order value ≥ $1, ` +
                            `estimated order value: $${minOrderValue.toFixed(2)} = (${calculatedTempPrice.toFixed(4)} + ${estimatedPriceBuffer.toFixed(4)}) × ${this.cfg.sharesPerSide})`
                        );
                    } else if (wasClampedToMax) {
                        logger.info(`⚠️ Threshold clamped to max: ${dynamicThreshold.toFixed(4)} → ${calculatedTempPrice.toFixed(4)}`);
                    }
                    logger.info(`🎯 New tracking price for ${oppositeToken}: ${calculatedTempPrice.toFixed(4)} (immediate buy trigger: <= ${(calculatedTempPrice - this.cfg.secondSideBuffer).toFixed(4)})`);
                } else {
                    logger.success(`🎯 DYNAMIC THRESHOLD: ${dynamicThreshold.toFixed(4)} | Will buy ${oppositeToken} when <= ${(dynamicThreshold - this.cfg.secondSideBuffer).toFixed(4)}`);
                }
            }
            if (!buySucceeded) {
                // Buy failed - switch to opposite token
                if (oppositeBuyCount >= this.cfg.maxBuysPerSide) {
                    logger.warning(`⚠️ Buy failed for ${currentToken} and opposite ${oppositeToken} is maxed (${oppositeBuyCount}/${this.cfg.maxBuysPerSide}). Stopping tracking.`);
                    tracking.trackingToken = null;
                    tracking.initialized = false;
                } else {
                    tracking.trackingToken = oppositeToken;
                    // Only set tempPrice to oppositePrice if we didn't already calculate a dynamic threshold
                    // (i.e., if buyPrice was null, meaning no order was placed)
                    if (buyPrice === null) {
                        tracking.tempPrice = oppositePrice;
                    }
                    // If buyPrice !== null, tracking.tempPrice was already set to calculatedTempPrice above, so preserve it
                    tracking.lastFailedBuyAttempt = now;
                    tracking.secondSideTimerSessionStart = null;
                    tracking.secondSideTimerAccumulated = 0;
                    // Note: Not logging "Buy failed" here because in fire-and-forget mode,
                    // buySucceeded check is unreliable (orders are confirmed asynchronously)
                }
            }
            return; // Exit early after depth-based buy attempt
        } else if (isReversal && !recentlyFailed) {
            // BUY TRIGGER!
            // Note: This uses full reversalDelta for reversal confirmation check
            // The percentage-adjusted reversalDelta is only used in dynamic threshold calculation after successful buy
            const actualPriceMovement = currentPrice - tracking.tempPrice;
            const opportunityDetectedAt = Date.now();
            // SPEED OPTIMIZATION: Mark opportunity for aggressive polling
            this.lastOpportunityTime = opportunityDetectedAt;
            // Check if this is the second side buy (firstBuyOfHedge is false)
            const isSecondSideBuy = !tracking.firstBuyOfHedge;
            const buySideLabel = isSecondSideBuy ? "🎯 SECOND BUY" : "⚡ BUY TRIGGER (Reversal)";
            logger.success(
                `${buySideLabel}: ${currentToken} @ ${currentPrice.toFixed(4)} ` +
                `(reversed from ${tracking.tempPrice.toFixed(4)}, movement=+${actualPriceMovement.toFixed(4)}, threshold=${reversalThreshold.toFixed(4)}) ` +
                `attempt_count=${attemptCount + 1}/${this.cfg.maxBuysPerSide}`
            );

            // Get state before buy to check if it succeeded
            const rowBefore = state[k] ?? emptyRow();
            const buyCountBefore = currentToken === "YES" ? rowBefore.buyCountYES : rowBefore.buyCountNO;

            // Execute buy
            const buyStartTime = Date.now();
            const buyPrice = await this.buySharesLimit(
                currentToken,
                currentTokenId,
                currentPrice,
                this.cfg.sharesPerSide,
                state,
                k,
                market,
                slug,
                conditionId,
                upIdx,
                downIdx
            );

            // Check if buy succeeded by comparing buy counts
            const rowAfter = state[k] ?? emptyRow();
            const buyCountAfter = currentToken === "YES" ? rowAfter.buyCountYES : rowAfter.buyCountNO;
            const buySucceeded = buyCountAfter > buyCountBefore;

            // CRITICAL: After any buy (success or fail), ALWAYS switch to opposite token
            // This enforces strict alternation within each hedge (after first buy)
            // Strategy: First buy is flexible (whichever token below threshold), then always alternate
            const oppositeToken = currentToken === "YES" ? "NO" : "YES";
            const oppositePrice = oppositeToken === "YES" ? upMid : downMid;
            const oppositeBuyCount = oppositeToken === "YES" ? rowAfter.buyCountYES : rowAfter.buyCountNO;

            if (buyPrice !== null) {
                // Calculate dynamic threshold for opposite token (second side of hedge)
                // NEW STRATEGY: Formula: 1 - previous token price + boost
                // Buy immediately when opposite token price <= (1 - buyPrice + boost) - buffer
                // No waiting for reversal - immediate buy for speed
                
                // Use actual fill price if available (from async order tracking), otherwise use limit price
                const actualBuyPrice = currentToken === "YES" ? 
                    (rowAfter.lastBuyPriceYES || buyPrice) : 
                    (rowAfter.lastBuyPriceNO || buyPrice);
                
                // Mark that first buy of hedge is complete - now enforce strict alternation
                if (tracking.firstBuyOfHedge) {
                    tracking.firstBuyOfHedge = false;
                    // Clear reset log tracking for this slug - new hedge has started
                    this.hedgeResetLoggedSlugs.delete(slug);
                    logger.success(`🎯 FIRST BUY: ${currentToken} @ ${actualBuyPrice.toFixed(4)} | Hedge started`);
                }
                
                const dynamicThreshold = 1 - actualBuyPrice + this.cfg.dynamicThresholdBoost; // Add boost for more aggressive buying
                
                if (actualBuyPrice !== buyPrice && config.debug) {
                    logger.debug(`📊 Using actual fill price ${actualBuyPrice.toFixed(4)} (vs limit ${buyPrice.toFixed(4)}) for dynamic threshold`);
                }

                // Ensure threshold meets $1 minimum order requirement
                // When placing order: limitPrice = tempPrice + priceBuffer
                // Order value = limitPrice * sharesPerSide >= $1
                // So: (tempPrice + priceBuffer) * sharesPerSide >= 1
                // Therefore: tempPrice >= (1 / sharesPerSide) - priceBuffer
                // Estimate price buffer (will be 0.01-0.02 depending on dynamic buffer)
                let estimatedPriceBuffer = 0.01; // Default
                if (this.cfg.dynamicPriceBuffer) {
                    const currentSumAvg = avg(rowAfter.costYES, rowAfter.qtyYES) + avg(rowAfter.costNO, rowAfter.qtyNO);
                    if (currentSumAvg > 0.9) {
                        estimatedPriceBuffer = 0.02;
                    } else if (currentSumAvg > 0.85) {
                        estimatedPriceBuffer = 0.015;
                    }
                }
                const minPriceForOrder = (1.0 / this.cfg.sharesPerSide) - estimatedPriceBuffer;
                const minAcceptableThreshold = Math.max(0, minPriceForOrder); // Ensure non-negative

                // Clamp between minimum order price and 1.0
                let calculatedTempPrice = Math.max(minAcceptableThreshold, Math.min(1, dynamicThreshold));

                // Track if we had to adjust for minimum order requirement
                const wasClampedToMin = dynamicThreshold < minAcceptableThreshold;
                const wasClampedToMax = dynamicThreshold > 1;

                tracking.trackingToken = oppositeToken;
                tracking.tempPrice = calculatedTempPrice;
                tracking.lastFailedBuyAttempt = 0; // Reset failure tracker
                tracking.secondSideTimerSessionStart = null;
                tracking.secondSideTimerAccumulated = 0; // Reset time tracking when switching to new side

                // Enhanced logging with formula breakdown
                logger.info(`🔄 Switched tracking: ${currentToken} → ${oppositeToken}`);
                // PERFORMANCE OPTIMIZATION: Only log detailed threshold calculation when DEBUG enabled
                if (config.debug) {
                    logger.info(
                        `📊 Dynamic threshold (second side): 1 - ${buyPrice.toFixed(4)} = ${dynamicThreshold.toFixed(4)} ` +
                        `(will buy ${oppositeToken} immediately when price <= ${(dynamicThreshold - this.cfg.secondSideBuffer).toFixed(4)} = ${dynamicThreshold.toFixed(4)} - ${this.cfg.secondSideBuffer.toFixed(4)} buffer)`
                    );
                    if (wasClampedToMin) {
                        const minOrderValue = (calculatedTempPrice + estimatedPriceBuffer) * this.cfg.sharesPerSide;
                        logger.info(
                            `⚠️ Threshold adjusted for $1 minimum order: ${dynamicThreshold.toFixed(4)} → ${calculatedTempPrice.toFixed(4)} ` +
                            `(min threshold: ${minAcceptableThreshold.toFixed(4)} to ensure order value ≥ $1, ` +
                            `estimated order value: $${minOrderValue.toFixed(2)} = (${calculatedTempPrice.toFixed(4)} + ${estimatedPriceBuffer.toFixed(4)}) × ${this.cfg.sharesPerSide})`
                        );
                    } else if (wasClampedToMax) {
                        logger.info(`⚠️ Threshold clamped to max: ${dynamicThreshold.toFixed(4)} → ${calculatedTempPrice.toFixed(4)}`);
                    }
                    logger.info(`🎯 New tracking price for ${oppositeToken}: ${calculatedTempPrice.toFixed(4)}`);
                } else {
                    logger.success(`🎯 DYNAMIC THRESHOLD: ${dynamicThreshold.toFixed(4)} | Will buy ${oppositeToken} when <= ${(dynamicThreshold - this.cfg.secondSideBuffer).toFixed(4)}`);
                }
            } 
            if (!buySucceeded) {
                // Buy failed - STILL switch to opposite token to enforce alternation
                // This maintains hedge balance even when buys fail
                // If opposite side is maxed out, we'll skip in next tick
                if (oppositeBuyCount >= this.cfg.maxBuysPerSide) {
                    // Opposite side already maxed, can't buy more - stop tracking
                    logger.warning(`⚠️ Buy failed for ${currentToken} and opposite ${oppositeToken} is maxed (${oppositeBuyCount}/${this.cfg.maxBuysPerSide}). Stopping tracking.`);
                    tracking.trackingToken = null;
                    tracking.initialized = false;
                } else {
                    // Switch to opposite token even though buy failed (maintain alternation)
                    tracking.trackingToken = oppositeToken;
                    // Only set tempPrice to oppositePrice if we didn't already calculate a dynamic threshold
                    // (i.e., if buyPrice was null, meaning no order was placed)
                    if (buyPrice === null) {
                        tracking.tempPrice = oppositePrice;
                    }
                    // If buyPrice !== null, tracking.tempPrice was already set to calculatedTempPrice above, so preserve it
                    tracking.lastFailedBuyAttempt = now; // Keep failure timestamp for cooldown
                    tracking.secondSideTimerSessionStart = null;
                    tracking.secondSideTimerAccumulated = 0;
                    // Note: Not logging "Buy failed" here because in fire-and-forget mode,
                    // buySucceeded check is unreliable (orders are confirmed asynchronously)
                }
            }
        }
    }

    private async buySharesLimit(
        leg: "YES" | "NO",
        tokenID: string,
        mid: number,
        size: number,
        state: CopytradeStateFile,
        key: string,
>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
        market: string,
        slug: string,
        conditionId: string,
        upIdx: number,
        downIdx: number
<<<<<<< HEAD
    ): Promise<boolean> {
        const limitPrice = askPrice+0.01; // Use askPrice directly for limit order

        const estimatedShares = size;

        const limitOrder: UserOrder = {
            tokenID,
            side: Side.BUY,
            price: limitPrice,
            size: size,
        };

        const orderAmount = limitPrice * size;

        // Log buy
        logger.info(`BUY: ${leg} ~${estimatedShares} shares @ limit ${limitPrice.toFixed(4)} (${orderAmount.toFixed(2)} USDC)`);

        // Place order IMMEDIATELY (await to ensure it's placed within 10ms)
        try {
            const response = await this.client.createAndPostOrder(
                limitOrder,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC // Good-Till-Cancel for limit orders
            );

            const orderID = response?.orderID;
            if (!orderID) {
                logger.error(`BUY failed for ${leg} - no orderID returned`);
                return false;
            }
            // Order placed successfully
            logger.info(`✅ First-Side Order placed: ${leg} orderID ${orderID.substring(0, 10)}... @ ${limitPrice.toFixed(4)}`);
            return true;
        } catch (e) {
            logger.error(`BUY failed for ${leg}: ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }

    /**
     * Execute prediction-based trading strategy
     * When prediction says UP → buy UP token, then at next prediction buy DOWN token
     * When prediction says DOWN → buy DOWN token, then at next prediction buy UP token
     */
    private executePredictionTrade(
        market: string,
        slug: string,
        prediction: PricePrediction,
        upAsk: number,
        downAsk: number,
        tokenIds: { upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        state: SimpleStateFile,
        k: string,
        row: SimpleStateRow
    ): void {
        // Initialize prediction score for this market/slug if not exists
        const scoreKey = `${market}-${slug}`;
        if (!this.predictionScores.has(scoreKey)) {
            this.predictionScores.set(scoreKey, {
                market,
                slug,
                startTime: Date.now(),
                endTime: null,
                upTokenCost: 0,
                downTokenCost: 0,
                upTokenCount: 0,
                downTokenCount: 0,
                totalPredictions: 0,
                correctPredictions: 0,
                trades: [],
            });
            // Track market start time if not already tracked
            if (!this.marketStartTimeBySlug.has(scoreKey)) {
                this.marketStartTimeBySlug.set(scoreKey, Date.now());
            }
        }

        const score = this.predictionScores.get(scoreKey)!;

        // CRITICAL: Only trade on high-confidence predictions to improve success rate
        // Wrong predictions have avg confidence ~48%, correct ones ~65%
        // Filter out low-confidence predictions to reduce losses
        // Reduced threshold to 50% to allow more trades with limit order second side strategy
        const minConfidenceForTrade = 0.50; // Reduced from 60% to 50% to allow more trades

        // Check confidence and signal before trading
        if (prediction.confidence < minConfidenceForTrade) {
            return; // Skip silently to reduce log noise
        }

        // Skip if signal is HOLD (indicates uncertainty)
        if (prediction.signal === "HOLD") {
            return; // Skip silently to reduce log noise
        }

        // Only increment totalPredictions when we actually make a trade
        score.totalPredictions++;

        // Determine which token to buy based on prediction direction only
        // Always follow prediction direction - no alternating logic
        let buyToken: "UP" | "DOWN" | null = null;
        let buyPrice = 0;
        let tokenId = "";

        if (prediction.direction === "up") {
            // Prediction says rising → buy UP token
            buyToken = "UP";
            buyPrice = upAsk;
            tokenId = tokenIds.upTokenId;
        } else if (prediction.direction === "down") {
            // Prediction says falling → buy DOWN token
            buyToken = "DOWN";
            buyPrice = downAsk;
            tokenId = tokenIds.downTokenId;
        }

        if (!buyToken) return; // No valid buy signal

        // Check if market is paused (reached 50 UP + 50 DOWN)
        if (this.pausedMarkets.has(scoreKey)) {
            return; // Skip silently - market paused
        }

        // Get or initialize token counts for this market
        let tokenCounts = this.tokenCountsByMarket.get(scoreKey);
        if (!tokenCounts) {
            tokenCounts = { upTokenCount: 0, downTokenCount: 0 };
            this.tokenCountsByMarket.set(scoreKey, tokenCounts);
        }

        // Check if we've reached the limit for this side BEFORE placing order
        // Use > instead of >= to prevent exceeding limit (if count is already at limit, don't place order)
        if (buyToken === "UP" && tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
            logger.info(`⛔ LIMIT REACHED: UP count is ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE} - skipping trade`);
            return; // Skip - limit reached
        }
        if (buyToken === "DOWN" && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
            logger.info(`⛔ LIMIT REACHED: DOWN count is ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE} - skipping trade`);
            return; // Skip - limit reached
        }

        // Increment count for the side we're buying ONLY (before calling buySharesWithRetry to prevent race conditions)
        if (buyToken === "UP") {
            tokenCounts.upTokenCount++;
            score.upTokenCount++;
        } else {
            tokenCounts.downTokenCount++;
            score.downTokenCount++;
        }

        // Execute the buy
        const buyCost = buyPrice * this.cfg.sharesPerSide;
        logger.info(`🎯 FIRST-SIDE Trade: ${buyToken} @ ${buyPrice.toFixed(4)} (${buyCost.toFixed(2)} USDC) | UP ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE} | Limit: ${this.MAX_BUY_COUNTS_PER_SIDE} per side`);

        // Place first-side order (fire-and-forget, don't wait for response)
        this.buySharesWithRetry(
            buyToken === "UP" ? "YES" : "NO",
            tokenId,
            buyPrice,
            this.cfg.sharesPerSide,
            state,
            k,
            row,
            market,
            slug,
            tokenIds.conditionId,
            tokenIds.upIdx,
            tokenIds.downIdx
        );

        // Place second-side limit order IMMEDIATELY (within 50ms) without waiting for first order response
        // This ensures both orders are placed almost simultaneously for better execution

        this.placeSecondSideLimitOrder(
            buyToken,
            buyPrice,
            tokenIds,
            market,
            slug,
            scoreKey,
            tokenCounts
        );

        // Track the trade cost for the side we actually bought only
        if (buyToken === "UP") {
            score.upTokenCost += buyCost;
        } else {
            score.downTokenCost += buyCost;
        }

        score.trades.push({
            prediction: prediction.direction,
            predictedPrice: prediction.predictedPrice,
            actualPrice: buyPrice,
            buyToken,
            buyPrice,
            buyCost,
            timestamp: Date.now(),
            wasCorrect: null, // Will be evaluated at next prediction
        });

        // Check if we've reached the limit (max UP + max DOWN)
        if (tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
            this.pausedMarkets.add(scoreKey);
            logger.info(`⏸️  Market ${scoreKey} PAUSED: Reached limit (UP: ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN: ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE})`);
        }
    }

    /**
     * Place limit order for second side (opposite token) at price (0.99 - firstSidePrice)
     */
    private async placeSecondSideLimitOrder(
        firstSide: "UP" | "DOWN",
        firstSidePrice: number,
        tokenIds: { upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        market: string,
        slug: string,
        scoreKey: string,
        tokenCounts: { upTokenCount: number; downTokenCount: number }
    ): Promise<void> {
        // Determine opposite side
        const oppositeSide = firstSide === "UP" ? "DOWN" : "UP";
        const oppositeTokenId = firstSide === "UP" ? tokenIds.downTokenId : tokenIds.upTokenId;

        // CRITICAL: Check if market is paused FIRST
        if (this.pausedMarkets.has(scoreKey)) {
            return; // Market is paused, don't place limit orders
        }

        // Calculate limit price: (0.99 - firstSidePrice)
        const limitPrice = 0.98 - firstSidePrice;

        // Ensure limit price is valid (between 0 and 1)
        if (limitPrice <= 0 || limitPrice >= 1) {
            logger.error(`⚠️  Invalid limit price calculated: ${limitPrice.toFixed(4)} (from first side price ${firstSidePrice.toFixed(4)})`);
            return;
        }

        const limitOrder: UserOrder = {
            tokenID: oppositeTokenId,
            side: Side.BUY,
            price: limitPrice,
            size: this.cfg.sharesPerSide,
        };

        try {
            // Place order IMMEDIATELY (await to ensure it's placed within 50ms of first order)
            const response = await this.client.createAndPostOrder(
                limitOrder,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC // Good-Till-Cancel for limit orders
            );
            
            const orderID = response?.orderID;
            // Log second-side limit order placement clearly with limit info
            const limitCost = limitPrice * this.cfg.sharesPerSide;
            if (orderID) {
                logger.info(`📋 SECOND-SIDE Limit Order: ${oppositeSide} @ ${limitPrice.toFixed(4)} (${limitCost.toFixed(2)} USDC) | First-Side: ${firstSide} @ ${firstSidePrice.toFixed(4)} | Current: UP ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE} | Limit: ${this.MAX_BUY_COUNTS_PER_SIDE} per side | OrderID: ${orderID.substring(0, 10)}...`);
                // Track second-side limit so fills update score (downTokenCost/upTokenCost and counts)
                const leg = oppositeSide === "UP" ? "YES" : "NO";
                this.trackLimitOrderAsync(
                    orderID,
                    leg,
                    oppositeTokenId,
                    tokenIds.conditionId,
                    this.cfg.sharesPerSide,
                    limitPrice,
                    market,
                    slug,
                    tokenIds.upIdx,
                    tokenIds.downIdx,
                    scoreKey,
                    tokenCounts
                ).catch(() => { /* fire-and-forget */ });
            } else {
                logger.error(`⚠️  Second-side limit order placement returned no orderID`);
            }
        } catch (e) {
            logger.error(`❌ Failed to place limit order for ${oppositeSide} token: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Track limit order asynchronously and update token counts when filled
     */
    private async trackLimitOrderAsync(
        orderID: string,
        leg: "YES" | "NO",
        tokenID: string,
        conditionId: string,
        estimatedShares: number,
        limitPrice: number,
        market: string,
        slug: string,
        upIdx: number,
        downIdx: number,
        scoreKey: string,
        tokenCounts: { upTokenCount: number; downTokenCount: number }
    ): Promise<void> {
        try {
            // Optimized polling with exponential backoff
            let attempts = 0;
            const maxAttempts = 30; // Reduced from 60 to 30 (30 seconds max)
            let pollInterval = 500; // Start with 500ms, increase gradually
            const maxInterval = 3000; // Max 3 seconds between checks

            while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                attempts++;

                try {
                    const order = await this.client.getOrder(orderID);

                    if (order && order.status === "FILLED") {
                        // CRITICAL: Check limit BEFORE incrementing to prevent exceeding limit
                        // This prevents race conditions where multiple limit orders fill simultaneously
                        const wouldExceedLimit = (leg === "YES" && tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) ||
                            (leg === "NO" && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE);

                        if (wouldExceedLimit) {
                            logger.error(`⚠️  Limit order ${orderID} filled but would exceed limit - cancelling count update (${leg}: ${leg === "YES" ? tokenCounts.upTokenCount : tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE})`);
                            return; // Don't increment count if it would exceed limit
                        }

                        // Order filled - update token counts
                        const fillCost = limitPrice * estimatedShares;

                        if (leg === "YES") {
                            tokenCounts.upTokenCount++;
                            const score = this.predictionScores.get(scoreKey);
                            if (score) {
                                score.upTokenCost += fillCost;
                                score.upTokenCount++;
                            }
                        } else {
                            tokenCounts.downTokenCount++;
                            const score = this.predictionScores.get(scoreKey);
                            if (score) {
                                score.downTokenCost += fillCost;
                                score.downTokenCount++;
                            }
                        }

                        logger.info(`✅ Limit order filled: ${leg} @ ${limitPrice.toFixed(4)} | UP ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}`);

                        // Check if we've reached the limit after this fill
                        if (tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
                            this.pausedMarkets.add(scoreKey);
                            logger.info(`⏸️  Market ${scoreKey} PAUSED after limit order fill: UP: ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN: ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}`);
                        }

                        // Also check if individual side reached limit (pause that side)
                        if (tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE || tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
                            // Market should be paused if both sides reach limit
                            if (tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
                                this.pausedMarkets.add(scoreKey);
                            }
                        }

                        return; // Order filled, stop tracking
                    } else if (order && (order.status === "CANCELLED" || order.status === "REJECTED")) {
                        return; // Order cancelled/rejected, stop tracking silently
                    }
                } catch (e) {
                    // Order might not be found yet, continue polling with backoff
                    // Increase interval gradually (exponential backoff)
                    if (pollInterval < maxInterval) {
                        pollInterval = Math.min(pollInterval * 1.5, maxInterval);
                    }
                    // Silent polling - no logging to reduce noise
                }
            }

            // Silent timeout - limit orders may fill later, no need to log
        } catch (e) {
            logger.error(`❌ Error tracking limit order ${orderID}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Update prediction score with previous prediction result
     * Only evaluates trades that were actually made (not skipped)
     */
    private updatePredictionScore(
        market: string,
        slug: string,
        prediction: PricePrediction,
        previousPrice: number,
        currentPrice: number,
        wasCorrect: boolean
    ): void {
        const scoreKey = `${market}-${slug}`;
        const score = this.predictionScores.get(scoreKey);
        if (!score) return;

        // Find the last trade that hasn't been evaluated yet
        const lastTrade = score.trades[score.trades.length - 1];
        if (lastTrade && lastTrade.wasCorrect === null) {
            lastTrade.wasCorrect = wasCorrect;
            if (wasCorrect) {
                score.correctPredictions++;
            }
            // Note: totalPredictions already incremented when trade was made
            // correctPredictions is updated here based on actual result
        }
    }

    /**
     * Generate prediction score summary when market cycle ends
     */
    private generatePredictionScoreSummary(prevSlug: string, market: string): void {
        const scoreKey = `${market}-${prevSlug}`;
        const score = this.predictionScores.get(scoreKey);
        if (!score) {
            logger.error(`⚠️  No prediction score found for ${scoreKey} - cannot generate summary`);
            return;
        }

        // Don't generate summary if already generated
        if (score.endTime !== null) {
            return;
        }

        score.endTime = Date.now();
        const duration = (score.endTime - score.startTime) / 1000; // seconds

        const successRate = score.totalPredictions > 0
            ? (score.correctPredictions / score.totalPredictions) * 100
            : 0;

        const totalCost = score.upTokenCost + score.downTokenCost;

        logger.info(`\n${"=".repeat(80)}`);
        logger.info(`📊 PREDICTION SCORE SUMMARY - Market: ${market} | Slug: ${prevSlug}`);
        logger.info(`${"=".repeat(80)}`);
        logger.info(`⏱️  Duration: ${(duration / 60).toFixed(2)} minutes`);
        logger.info(`📈 Total Predictions: ${score.totalPredictions}`);
        logger.info(`✅ Correct Predictions: ${score.correctPredictions}`);
        logger.info(`❌ Wrong Predictions: ${score.totalPredictions - score.correctPredictions}`);
        logger.info(`🎯 Success Rate: ${successRate.toFixed(2)}%`);
        logger.info(`\n💰 TOKEN PURCHASES:`);
        logger.info(`   UP Token:`);
        logger.info(`      - Buy Count: ${score.upTokenCount}`);
        logger.info(`      - Total Cost: ${score.upTokenCost.toFixed(2)} USDC`);
        logger.info(`   DOWN Token:`);
        logger.info(`      - Buy Count: ${score.downTokenCount}`);
        logger.info(`      - Total Cost: ${score.downTokenCost.toFixed(2)} USDC`);
        logger.info(`\n💵 TOTAL COST: ${totalCost.toFixed(2)} USDC`);
        logger.info(`${"=".repeat(80)}\n`);

        // Remove from active tracking (summary generated)
        this.predictionScores.delete(scoreKey);
    }

    /**
     * Generate prediction score summaries for all active markets
     * Called on shutdown or periodically
     */
    private generateAllPredictionSummaries(): void {
        const now = new Date();
        const minutes = now.getMinutes();

        // Only generate summaries at quarter-hour boundaries (0m, 15m, 30m, 45m)
        if (minutes !== 0 && minutes !== 15 && minutes !== 30 && minutes !== 45) {
            return; // Not at a quarter-hour boundary, skip
        }

        // Generate summary for each active market/slug
        const scores = Array.from(this.predictionScores.entries());
        for (const [scoreKey, score] of scores) {
            if (score.endTime === null && score.totalPredictions > 0) {
                // Market is still active and has predictions, generate summary now
                // Use stored market and slug from score object
                this.generatePredictionScoreSummary(score.slug, score.market);
            }
        }
    }

    /**
     * Track order asynchronously and log holdings when filled
     */
    private async trackOrderAsync(
        orderID: string,
        leg: "YES" | "NO",
        tokenID: string,
        conditionId: string,
        estimatedShares: number,
        askPrice: number,
        state: SimpleStateFile,
        key: string,
        market: string,
        slug: string,
        upIdx: number,
        downIdx: number
    ): Promise<void> {
        let lastLoggedSize = 0;
        const maxAttempts = 10;
        const delayMs = 100;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const order = await this.client.getOrder(orderID);
                if (!order) {
                    if (attempt < maxAttempts - 1) {
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        continue;
                    }
                    logger.error(`Order ${orderID} not found after ${maxAttempts} attempts`);
                    return;
                }

                const status = order.status;
                const sizeMatched = typeof order.size_matched === "number" ? order.size_matched : (typeof order.size_matched === "string" ? parseFloat(order.size_matched) : 0);

                // Check if order is filled (fully or partially)
                if (status === "MATCHED" || status === "FILLED" || status === "PARTIALLY_FILLED" || sizeMatched > 0) {
                    const newlyFilled = sizeMatched - lastLoggedSize;
                    if (newlyFilled > 0) {
                        // Log holdings for redemption - use conditionId as the key, not market name
                        addHoldings(conditionId, tokenID, newlyFilled);
                        logger.info(`✅ ${leg} order ${orderID} filled: ${newlyFilled} shares (total matched: ${sizeMatched}/${estimatedShares})`);
                        lastLoggedSize = sizeMatched;
                    }

                    // If fully filled, we're done
                    if (status === "FILLED" || status === "MATCHED" || sizeMatched >= estimatedShares) {
                        logger.info(`✅ ${leg} order ${orderID} fully filled: ${sizeMatched} shares`);
                        return;
                    }
                }

                // If order is cancelled or failed, stop tracking
                if (status === "CANCELLED" || status === "FAILED") {
                    logger.error(`Order ${orderID} ${status.toLowerCase()}`);
                    return;
                }

                // Wait before next check
                if (attempt < maxAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            } catch (e) {
                logger.error(`Error tracking order ${orderID}: ${e instanceof Error ? e.message : String(e)}`);
                if (attempt < maxAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }

        logger.error(`Order ${orderID} tracking completed after ${maxAttempts} attempts (may still be pending)`);
    }
}
=======
    ): Promise<number | null> {
        // Returns the actual buy price (limitPrice) if successful, null if failed
        // Increment attempt counter FIRST (before any early returns)
        // This ensures all attempts (successful + failed) count towards MAX_BUYS_PER_SIDE
        const row = state[key] ?? emptyRow();
        if (!state[key]) {
            state[key] = row; // Ensure row is in state if it was just created
        }
        if (leg === "YES") {
            row.attemptCountYES += 1;
        } else {
            row.attemptCountNO += 1;
        }
        // PERFORMANCE OPTIMIZATION: Save state asynchronously (debounced) - don't block
        saveState(state);

        // SPEED OPTIMIZATION: Use configurable price buffer (default 3 cents for faster fills)
        // Dynamic buffer: increase if sumAvg is high (more aggressive) or if dynamic buffer is enabled
        let priceBuffer = this.cfg.priceBuffer || 0.03; // Default 3 cents buffer (was 0.01)
        if (this.cfg.dynamicPriceBuffer) {
            const currentSumAvg = avg(row.costYES, row.qtyYES) + avg(row.costNO, row.qtyNO);
            // Increase buffer if sumAvg is high (need more aggressive pricing)
            if (currentSumAvg > 0.9) {
                priceBuffer = Math.max(priceBuffer, 0.05); // 5 cents if sumAvg > 0.9 (was 0.02)
            } else if (currentSumAvg > 0.85) {
                priceBuffer = Math.max(priceBuffer, 0.04); // 4 cents if sumAvg > 0.85 (was 0.015)
            }
        }
        const limitPrice = roundDownToTick(mid + priceBuffer, this.cfg.tickSize);

        if (!(limitPrice > 0 && limitPrice < 1)) {
            logger.warning(`Copytrade: market=${market} slug=${slug} invalid limit price ${limitPrice} for leg=${leg}`);
            return null;
        }

        // Check minimum order size ($1 requirement from Polymarket)
        // If order value would be < $1, adjust share count to meet minimum
        let adjustedSize = size;
        const orderValue = limitPrice * size;
        if (orderValue < 1.0) {
            // Calculate minimum shares needed to meet $1 requirement
            const minSharesNeeded = Math.ceil(1.0 / limitPrice);
            adjustedSize = minSharesNeeded;
            const adjustedOrderValue = limitPrice * adjustedSize;
            logger.info(
                `💰 Adjusted shares to meet $1 minimum: ${size} → ${adjustedSize} shares ` +
                `(order value: $${orderValue.toFixed(2)} → $${adjustedOrderValue.toFixed(2)} at price=${limitPrice.toFixed(4)})`
            );
        }

        // Use adjusted size for the rest of the function
        const finalSize = adjustedSize;

        // Check if this buy would make sumAvg unprofitable (> 0.98)
        // Use finalSize (adjusted if needed) for projections
        const projectedCostYES = leg === "YES" ? row.costYES + (limitPrice * finalSize) : row.costYES;
        const projectedQtyYES = leg === "YES" ? row.qtyYES + finalSize : row.qtyYES;
        const projectedCostNO = leg === "NO" ? row.costNO + (limitPrice * finalSize) : row.costNO;
        const projectedQtyNO = leg === "NO" ? row.qtyNO + finalSize : row.qtyNO;

        const projectedAvgYES = projectedQtyYES > 0 ? projectedCostYES / projectedQtyYES : 0;
        const projectedAvgNO = projectedQtyNO > 0 ? projectedCostNO / projectedQtyNO : 0;
        const projectedSumAvg = projectedAvgYES + projectedAvgNO;

        if (projectedSumAvg > this.cfg.maxSumAvg) {
            logger.warning(
                `Copytrade: market=${market} slug=${slug} skipping ${leg} buy at ${limitPrice.toFixed(4)} - ` +
                `would make sumAvg ${projectedSumAvg.toFixed(4)} > ${this.cfg.maxSumAvg} (unprofitable). ` +
                `Current: avgYES=${avg(row.costYES, row.qtyYES).toFixed(4)} avgNO=${avg(row.costNO, row.qtyNO).toFixed(4)}`
            );
            // return null;
        }

        const userOrder: UserOrder = {
            tokenID,
            side: Side.BUY,
            price: limitPrice,
            size: finalSize, // Use adjusted size to meet $1 minimum
        };

        // SPEED OPTIMIZATION: For limit orders, we use GTC with aggressive pricing
        // Note: FAK is for market orders (UserMarketOrder), not limit orders (UserOrder)
        // We achieve speed through: aggressive price buffer + fire-and-forget
        const orderType = OrderType.GTC;
        const orderTypeStr = this.cfg.useFakOrders ? "GTC (aggressive pricing for speed)" : "GTC (Good-Till-Cancel)";

        const orderStartTime = Date.now();
        logger.info(
            `⚡ Copytrade BUY market=${market} slug=${slug} leg=${leg} size=${finalSize}${finalSize !== size ? ` (adjusted from ${size})` : ''} conditionId=${conditionId} (limit=${limitPrice}, mid=${mid}) type=${orderTypeStr}`
        );

        let response;
        const orderPlaceStartTime = Date.now();
        try {
            const orderOptions = { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk };
            const simulateUrl = process.env.CLOB_SIMULATE_URL || "https://polymarket-clob.com/";
            if (simulateUrl) {
                const signedOrder = await this.client.createOrder(userOrder, orderOptions);
                response = await this.client.postOrder(signedOrder, orderType);
            } else {
                response = await this.client.createAndPostOrder(userOrder, orderOptions, orderType);
            }
            const orderPlaceTime = Date.now() - orderPlaceStartTime;
            logger.info(`⚡ Order placed in ${orderPlaceTime}ms`);
            this.metrics.totalOrders++;
        } catch (e) {
            this.metrics.failedOrders++;
            this.metrics.errors++;
            this.metrics.apiErrors++;
            logger.error(`Copytrade BUY order creation failed market=${market} slug=${slug} leg=${leg}: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }

        const orderID = response?.orderID;
        if (!orderID) {
            logger.error(`Copytrade BUY failed market=${market} slug=${slug} leg=${leg} - no orderID returned (likely balance/allowance issue)`);
            return null;
        }

        // Check if we've already processed this order (prevent duplicates)
        if (this.processedOrders.has(orderID)) {
            logger.warning(`Order ${orderID} already processed, skipping duplicate`);
            return null;
        }

        // SPEED OPTIMIZATION: Fire-and-forget mode - don't wait for confirmation
        if (this.cfg.fireAndForget) {
            // Track order asynchronously without blocking
            this.trackOrderAsync(orderID, leg, tokenID, conditionId, finalSize, limitPrice, state, key, market, slug, upIdx, downIdx);

            const totalTime = Date.now() - orderStartTime;
            logger.success(`⚡ Order ${orderID.substring(0, 20)}... placed and tracking async (total: ${totalTime}ms) - continuing immediately`);

            // Return immediately with limit price (assume success for now)
            // Order will be verified asynchronously
            return limitPrice;
        }

        // Traditional mode: Wait for order confirmation (slower but more reliable)
        // SPEED OPTIMIZATION: Reduced delays
        const initialDelay = this.cfg.orderCheckInitialDelayMs || 100; // Reduced from 500ms
        // PERFORMANCE OPTIMIZATION: Only log when DEBUG enabled (reduces log spam)
        if (config.debug) {
            logger.info(`Waiting ${initialDelay}ms for order to be matched...`);
        }
        await new Promise(resolve => setTimeout(resolve, initialDelay));

        // Try to get order status with retry logic (reduced attempts and delays)
        let order;
        let orderCheckAttempts = 0;
        const maxOrderCheckAttempts = this.cfg.orderCheckMaxAttempts || 2; // Reduced from 3
        const retryDelay = this.cfg.orderCheckRetryDelayMs || 300; // Reduced from 1000ms

        while (orderCheckAttempts < maxOrderCheckAttempts) {
            try {
                order = await this.client.getOrder(orderID);

                if (order && order.status) {
                    // If order is MATCHED, we're done!
                    if (order.status === "MATCHED") {
                        logger.debug(`⚡ Order MATCHED on attempt ${orderCheckAttempts + 1}`);
                        break;
                    }

                    // If order is LIVE and we have retries left, wait and check again
                    if (order.status === "LIVE" && orderCheckAttempts < maxOrderCheckAttempts - 1) {
                        // PERFORMANCE OPTIMIZATION: Only log when DEBUG enabled
                        if (config.debug) {
                            logger.info(`Order status LIVE, waiting ${retryDelay}ms for it to match (attempt ${orderCheckAttempts + 1}/${maxOrderCheckAttempts})...`);
                        }
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                        orderCheckAttempts++;
                        continue;
                    }

                    // For other statuses or last attempt, break and handle below
                    break;
                }

                // If order is null/invalid, wait and retry
                // PERFORMANCE OPTIMIZATION: Only log when DEBUG enabled (reduces log spam)
                if (config.debug) {
                    logger.warning(`Order status check returned invalid response, attempt ${orderCheckAttempts + 1}/${maxOrderCheckAttempts}, waiting ${retryDelay}ms...`);
                }
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                orderCheckAttempts++;
            } catch (e) {
                // PERFORMANCE OPTIMIZATION: Only log when DEBUG enabled
                if (config.debug) {
                    logger.warning(`Order status check failed, attempt ${orderCheckAttempts + 1}/${maxOrderCheckAttempts}: ${e instanceof Error ? e.message : String(e)}, waiting ${retryDelay}ms...`);
                }
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                orderCheckAttempts++;
            }
        }

        // If we still don't have a valid order after retries, abort
        if (!order || !order.status) {
            logger.error(`Copytrade BUY failed market=${market} slug=${slug} leg=${leg} orderID=${orderID} - could not verify order status after ${maxOrderCheckAttempts} attempts`);
            return null;
        }

        logger.debug(`Final order status: ${order.status} for ${leg} orderID=${orderID}`);

        if (order.status !== "MATCHED") {
            logger.error(`Copytrade BUY failed market=${market} slug=${slug} leg=${leg} conditionId=${conditionId} orderID=${orderID} status=${order.status} (order may still be on order book)`);
        }

        const tokensReceived = response?.takingAmount ? parseFloat(response.takingAmount) : finalSize;
        const usdcSpent = response?.makingAmount ? parseFloat(response.makingAmount) : tokensReceived * limitPrice;

        if (tokensReceived > 0) {
            addHoldings(conditionId, tokenID, tokensReceived);
        }

        // Use the same row reference (already in state, attemptCount already incremented)
        // Store attribution metadata for PnL logging during redemption.
        row.market = market;
        row.slug = slug;
        row.conditionId = conditionId;
        row.upIdx = upIdx;
        row.downIdx = downIdx;
        if (leg === "YES") {
            row.qtyYES += tokensReceived;
            row.costYES += usdcSpent;
            row.buyCountYES += 1;
            row.lastBuySide = "YES"; // Track last successful buy side
        } else {
            row.qtyNO += tokensReceived;
            row.costNO += usdcSpent;
            row.buyCountNO += 1;
            row.lastBuySide = "NO"; // Track last successful buy side
        }
        row.buysCount += 1;
        row.lastUpdatedIso = new Date().toISOString();
        state[key] = row;
        saveState(state);

        // Mark order as processed to prevent duplicates
        this.processedOrders.set(orderID, Date.now());

        // Remove from open orders (order is matched)
        this.openOrders.delete(orderID);

        // Update metrics
        this.metrics.successfulOrders++;
        this.metrics.totalSpent += usdcSpent;
        this.metrics.totalReceived += tokensReceived;

        const avgYes = avg(row.costYES, row.qtyYES);
        const avgNo = avg(row.costNO, row.qtyNO);
        const currentSumAvg = avgYes + avgNo;

        // Track average sumAvg
        this.metrics.avgSumAvg += currentSumAvg;
        this.metrics.sumAvgSamples++;

        // Cleanup old processed orders (keep last 100 orders)
        if (this.processedOrders.size > 100) {
            const entries = Array.from(this.processedOrders.entries());
            entries.sort((a, b) => a[1] - b[1]); // Sort by timestamp
            for (let i = 0; i < entries.length - 100; i++) {
                this.processedOrders.delete(entries[i][0]);
            }
        }

        const totalTime = Date.now() - orderStartTime;
        logger.success(
            `⚡ Copytrade BUY done market=${market} slug=${slug} leg=${leg} conditionId=${conditionId} orderID=${response?.orderID || "N/A"} filled=${tokensReceived} spent=${usdcSpent.toFixed(
                6
            )} avgYES=${avgYes.toFixed(4)} avgNO=${avgNo.toFixed(4)} sumAvg=${currentSumAvg.toFixed(4)} totalTime=${totalTime}ms`
        );

        // Return the actual buy price (limitPrice) for dynamic threshold calculation
        return limitPrice;
    }
}

// Backwards-compatible entrypoint (new name)
export const copytrade = (client: ClobClient) => CopytradeArbBot.fromEnv(client);


>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
