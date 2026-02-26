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
    private tokenIdsByMarket: Record<
        string,
        { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number }
    > = {};
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
        }
    }

    /**
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
        market: string,
        slug: string,
        conditionId: string,
        upIdx: number,
        downIdx: number
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
