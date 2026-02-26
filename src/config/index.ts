import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

// Load `.env` once for the whole app. Safe if the file doesn't exist.
dotenvConfig({ path: resolve(process.cwd(), ".env") });

function envString(name: string, fallback?: string): string | undefined {
    const v = process.env[name];
    const t = typeof v === "string" ? v.trim() : "";
    if (t) return t;
    return fallback;
}

function envNumber(name: string, fallback: number): number {
    const raw = envString(name);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
    const raw = envString(name);
    if (!raw) return fallback;
    return raw.toLowerCase() === "true";
}

function envCsvLower(name: string, fallbackCsv: string): string[] {
    const raw = envString(name, fallbackCsv) ?? fallbackCsv;
    return raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function requireEnv(name: string): string {
    const v = envString(name);
    if (!v) throw new Error(`${name} not found`);
    return v;
}

export const config = {
    /** Enable verbose logs */
    debug: envBool("DEBUG", false),

    /** EVM chain id (Polygon mainnet = 137) */
    chainId: envNumber("CHAIN_ID", 137),

    /** Polymarket CLOB API base URL */
    clobApiUrl: envString("CLOB_API_URL", "https://clob.polymarket.com")!,

    /** Wallet private key (required for most scripts). Use config.requirePrivateKey() when needed. */
    privateKey: envString("PRIVATE_KEY"),
    requirePrivateKey: () => requireEnv("PRIVATE_KEY"),

    /** Use Polymarket proxy/smart wallet (set true only if you trade via proxy; default EOA) */
    useProxyWallet: envBool("USE_PROXY_WALLET", false),
    /** Proxy/Polymarket profile address (where USDC is held); only used when USE_PROXY_WALLET=true */
    prozyWalletAddress: envString("PROZY_WALLET_ADDRESS", "0xcbb677eBF16eB7B1d372499eDaF01Cb6B083De9B")!,

    /** RPC configuration (used for on-chain calls like allowance/balance/redeem). */
    rpcUrl: envString("RPC_URL"),
    rpcToken: envString("RPC_TOKEN"),

    /** Global neg-risk toggle used by some on-chain allowance helpers */
    negRisk: envBool("NEG_RISK", false),

    /** Bot runner settings */
    bot: {
        minUsdcBalance: envNumber("BOT_MIN_USDC_BALANCE", 1),
        waitForNextMarketStart: envBool("COPYTRADE_WAIT_FOR_NEXT_MARKET_START", false),
    },

    /** Console file logging */
    logging: {
        logFilePath: envString("LOG_FILE_PATH"),
        logDir: envString("LOG_DIR", "logs")!,
        logFilePrefix: envString("LOG_FILE_PREFIX", "bot")!,
    },

    /** Copytrade bot settings */
    copytrade: {
        markets: envCsvLower("COPYTRADE_MARKETS", envString("GABAGOOL_MARKETS", "btc")!),
        sharesPerSide: envNumber("COPYTRADE_SHARES", envNumber("GABAGOOL_SHARES", 5)),
        tickSize: (envString("COPYTRADE_TICK_SIZE", envString("GABAGOOL_TICK_SIZE", "0.01")!) ??
            "0.01") as "0.01" | "0.001" | "0.0001" | string,
        negRisk: envBool("COPYTRADE_NEG_RISK", envBool("GABAGOOL_NEG_RISK", false)),
        priceBuffer: envNumber("COPYTRADE_PRICE_BUFFER", 0), // Price buffer in cents for order execution (faster fills)
        fireAndForget: envBool("COPYTRADE_FIRE_AND_FORGET", true), // Don't wait for order confirmation (faster)
        minBalanceUsdc: envNumber("COPYTRADE_MIN_BALANCE_USDC", 1), // Minimum balance before stopping
        maxBuyCountsPerSide: envNumber("COPYTRADE_MAX_BUY_COUNTS_PER_SIDE", 0), // Maximum buy counts per side (UP/DOWN) per market before pausing
    },

    /** Redeem script args via env */
    redeem: {
        conditionId: envString("CONDITION_ID"),
        indexSets: envString("INDEX_SETS"),
    },
};


