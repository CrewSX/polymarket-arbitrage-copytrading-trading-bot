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
    private tokenIdsByMarket: Record<
        string,
        { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number }
    > = {};
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
        }
    }

    /**
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
        market: string,
        slug: string,
        conditionId: string,
        upIdx: number,
        downIdx: number
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


