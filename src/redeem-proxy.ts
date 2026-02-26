/**
 * Redeem script using Proxy Factory
 * 
 * This script redeems conditional tokens through a proxy wallet factory,
 * which is the recommended approach for Polymarket redemptions.
 * 
 * Uses `src/data/token-holding.json` (written by the bot) and redeems any markets that are resolved.
 * 
 * Usage:
 *   ts-node src/redeem-proxy.ts                    # Redeem all resolved markets from holdings
 *   ts-node src/redeem-proxy.ts --dry-run          # Check but don't redeem
 *   ts-node src/redeem-proxy.ts --loop --interval-ms 30000  # Loop mode
 *   ts-node src/redeem-proxy.ts --condition-id=0x...  # Redeem specific condition ID
 * 
 * Environment variables required:
 *   - PRIVATE_KEY: Your wallet private key
 *   - RPC_URL: Polygon RPC endpoint
 *   - CONDITION_ID: (optional) Condition ID to redeem (if not using holdings file)
 *   - NEG_RISK: (optional) Set to "true" if redeeming neg-risk tokens
 */

import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";
import { parseUnits } from "@ethersproject/units";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { proxyFactoryAbi } from "./abis/proxyFactory";
import { encodeRedeem, encodeRedeemNegRisk } from "./utils/encode";
import { config } from "./config";
import { logger } from "./utils/logger";
import { checkConditionResolution, isMarketResolved } from "./utils/redeem";
import { getAllHoldings, clearMarketHoldings } from "./utils/holdings";

// Contract addresses
export const PROXY_WALLET_FACTORY_ADDRESS = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";
export const SAFE_FACTORY_ADDRESS = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";
export const SAFE_MULTISEND_ADDRESS = "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761";
export const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
export const USDCE_DIGITS = 6;
export const SAFE_FACTORY_NAME = "Polymarket Contract Proxy Factory";

// Load environment variables
dotenvConfig({ path: resolve(__dirname, "..", ".env") });

function getArgValue(args: string[], key: string): string | undefined {
    const i = args.indexOf(key);
    if (i === -1) return undefined;
    return args[i + 1];
}

function msUntilNext15mBoundary(now: Date = new Date()): number {
    const d = new Date(now);
    d.setSeconds(0, 0);
    const m = d.getMinutes();
    const nextMin = (Math.floor(m / 15) + 1) * 15;
    d.setMinutes(nextMin, 0, 0);
    return Math.max(0, d.getTime() - now.getTime());
}

async function sleep(ms: number): Promise<void> {
    if (!(ms > 0)) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldDropHoldingsForError(err?: string): boolean {
    if (!err) return false;
    return /don't hold any winning tokens/i.test(err);
}

/**
 * Retry a function with exponential backoff
 */
async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 1000
): Promise<T> {
    let lastError: Error | unknown;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const errorMsg = error instanceof Error ? error.message : String(error);
            
            // Check if error is retryable (RPC errors, network errors, etc.)
            const isRetryable = 
                errorMsg.includes("network") ||
                errorMsg.includes("timeout") ||
                errorMsg.includes("ECONNREFUSED") ||
                errorMsg.includes("ETIMEDOUT") ||
                errorMsg.includes("RPC") ||
                errorMsg.includes("rate limit") ||
                errorMsg.includes("nonce") ||
                errorMsg.includes("replacement transaction");
            
            if (!isRetryable || attempt === maxRetries) {
                throw error;
            }
            
            const backoffDelay = delayMs * Math.pow(2, attempt - 1);
            logger.error(`Attempt ${attempt}/${maxRetries} failed: ${errorMsg}. Retrying in ${backoffDelay}ms...`);
            await sleep(backoffDelay);
        }
    }
    
    throw lastError;
}

/**
 * Redeem a single market using proxy factory
 */
async function redeemMarketWithProxy(
    conditionId: string,
    negRisk: boolean = false,
    redeemAmounts: string[] = ["1", "1"]
): Promise<any> {
    const privateKey = config.requirePrivateKey();
    const rpcUrl = config.rpcUrl;
    
    if (!rpcUrl) {
        throw new Error("RPC_URL not found in environment variables");
    }

    // Create provider and wallet
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);

    // Create proxy factory contract instance
    const factory = new Contract(PROXY_WALLET_FACTORY_ADDRESS, proxyFactoryAbi, wallet);

    // Encode the redeem transaction data
    const data = negRisk 
        ? encodeRedeemNegRisk(conditionId, redeemAmounts)
        : encodeRedeem(USDC_ADDRESS, conditionId);

    // Determine target contract
    const to = negRisk ? NEG_RISK_ADAPTER_ADDRESS : CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS;

    // Prepare proxy transaction
    const proxyTxn = {
        to: to,
        typeCode: 1, // Standard transaction type (number, not string)
        data: data,
        value: "0",
    };

    // Execute the transaction
    const gasPrice = parseUnits("100", "gwei"); // 100 gwei
    const txn = await factory.proxy([proxyTxn], { gasPrice });
    
    logger.info(`Transaction hash: ${txn.hash}`);
    logger.info("Waiting for confirmation...");
    
    const receipt = await txn.wait();
    
    logger.info(`✅ Successfully redeemed ${conditionId}`);
    logger.info(`Transaction confirmed in block ${receipt.blockNumber}`);
    logger.info(`Gas used: ${receipt.gasUsed.toString()}`);
    
    return receipt;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const loop = args.includes("--loop") || !args.includes("--once");
    const intervalMs = Number(getArgValue(args, "--interval-ms") ?? "200000"); // 15m
    const maxRetries = Number(getArgValue(args, "--max-retries") ?? "3");
    const initialDelayMs = Number(getArgValue(args, "--initial-delay-ms") ?? "200000"); // 200s
    const align = !(args.includes("--no-align"));

    // Check if neg-risk (from env or args)
    const negRiskArg = args.find(arg => arg.startsWith("--neg-risk="));
    const negRisk = negRiskArg 
        ? negRiskArg.split("=")[1].toLowerCase() === "true"
        : config.negRisk || process.env.NEG_RISK === "true";

    // Get redeem amounts for neg-risk (optional, defaults to ["1", "1"])
    const amountsArg = args.find(arg => arg.startsWith("--amounts="));
    const redeemAmounts = amountsArg 
        ? amountsArg.split("=")[1].split(",").map(a => a.trim())
        : ["1", "1"];

    // Get condition ID from env or command line args (for single redemption)
    const conditionIdArg = args.find(arg => arg.startsWith("--condition-id="));
    const singleConditionId = conditionIdArg 
        ? conditionIdArg.split("=")[1] 
        : config.redeem.conditionId || process.env.CONDITION_ID;

    let running = false;
    const runOnce = async () => {
        if (running) return;
        running = true;
        try {
            // If single condition ID is provided, redeem only that one
            if (singleConditionId) {
                logger.info(`\n=== REDEEMING SINGLE MARKET ===`);
                logger.info(`Condition ID: ${singleConditionId}`);
                logger.info(`Neg Risk: ${negRisk}`);

                // Check if market is resolved
                logger.info("\n=== CHECKING MARKET RESOLUTION ===");
                const { isResolved, reason } = await isMarketResolved(singleConditionId);
                
                if (!isResolved) {
                    throw new Error(`Market is not yet resolved. ${reason}`);
                }

                if (dryRun) {
                    logger.info(`[DRY RUN] Would redeem: ${singleConditionId}`);
                } else {
                    await retryWithBackoff(
                        async () => {
                            await redeemMarketWithProxy(singleConditionId, negRisk, redeemAmounts);
                        },
                        maxRetries,
                        2000
                    );
                    
                    // Clear holdings after successful redemption
                    try {
                        clearMarketHoldings(singleConditionId);
                        logger.info(`Cleared holdings record for ${singleConditionId} from token-holding.json`);
                    } catch (clearError) {
                        logger.error(`Failed to clear holdings for ${singleConditionId}: ${clearError instanceof Error ? clearError.message : String(clearError)}`);
                    }
                }
                return;
            }

            // Otherwise, use holdings file
            logger.info("\n=== USING HOLDINGS FILE METHOD ===");
            const holdings = getAllHoldings();
            const marketIds = Object.keys(holdings);
            
            if (marketIds.length === 0) {
                logger.error("No holdings found in token-holding.json. Nothing to redeem.");
                return;
            }

            logger.info(`Found ${marketIds.length} market(s) in holdings`);
            logger.info("Checking which markets are resolved...\n");

            const results: Array<{
                conditionId: string;
                isResolved: boolean;
                redeemed: boolean;
                error?: string;
            }> = [];

            let resolvedCount = 0;
            let redeemedCount = 0;
            let failedCount = 0;

            for (const conditionId of marketIds) {
                logger.info(`Checking market: ${conditionId}`);
                try {
                    // Check if market is resolved
                    const { isResolved, reason } = await isMarketResolved(conditionId);
                    
                    if (isResolved) {
                        resolvedCount++;
                        
                        if (dryRun) {
                            logger.info(`[DRY RUN] Would redeem: ${conditionId}`);
                            results.push({
                                conditionId,
                                isResolved: true,
                                redeemed: false,
                            });
                        } else {
                            try {
                                // Redeem the market with retry logic
                                logger.info(`\nRedeeming resolved market: ${conditionId}`);
                                
                                await retryWithBackoff(
                                    async () => {
                                        await redeemMarketWithProxy(conditionId, negRisk, redeemAmounts);
                                    },
                                    maxRetries,
                                    2000 // 2 second initial delay, then 4s, 8s
                                );
                                
                                redeemedCount++;
                                
                                // Automatically clear holdings after successful redemption
                                try {
                                    clearMarketHoldings(conditionId);
                                    logger.info(`Cleared holdings record for ${conditionId} from token-holding.json`);
                                } catch (clearError) {
                                    logger.error(`Failed to clear holdings for ${conditionId}: ${clearError instanceof Error ? clearError.message : String(clearError)}`);
                                }
                                
                                results.push({
                                    conditionId,
                                    isResolved: true,
                                    redeemed: true,
                                });
                            } catch (error) {
                                failedCount++;
                                const errorMsg = error instanceof Error ? error.message : String(error);
                                logger.error(`Failed to redeem ${conditionId} after ${maxRetries} attempts`, error);
                                results.push({
                                    conditionId,
                                    isResolved: true,
                                    redeemed: false,
                                    error: errorMsg,
                                });

                                // If market is resolved but we hold only losing tokens, remove from holdings
                                if (shouldDropHoldingsForError(errorMsg)) {
                                    logger.error(`Dropping holdings for conditionId=${conditionId} (no winning tokens to redeem)`);
                                    try {
                                        clearMarketHoldings(conditionId);
                                    } catch (e) {
                                        logger.error(`Failed to clear holdings for ${conditionId}`, e);
                                    }
                                }
                            }
                        }
                    } else {
                        logger.info(`Market ${conditionId} not resolved: ${reason}`);
                        results.push({
                            conditionId,
                            isResolved: false,
                            redeemed: false,
                            error: reason,
                        });
                    }
                } catch (error) {
                    failedCount++;
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logger.error(`Error processing ${conditionId}`, error);
                    results.push({
                        conditionId,
                        isResolved: false,
                        redeemed: false,
                        error: errorMsg,
                    });
                }
            }

            // Print summary
            logger.info(`\n=== REDEMPTION SUMMARY ===`);
            logger.info(`Total markets: ${marketIds.length}`);
            logger.info(`Resolved: ${resolvedCount}`);
            if (dryRun) {
                logger.info(`Would redeem: ${resolvedCount} market(s)`);
            } else {
                logger.info(`Successfully redeemed: ${redeemedCount} market(s)`);
                if (failedCount > 0) {
                    logger.error(`Failed: ${failedCount} market(s)`);
                }
            }
        } catch (e) {
            logger.error("redeem-proxy run failed", e);
        } finally {
            running = false;
        }
    };

    if (!loop) {
        await runOnce();
        return;
    }

    const waitMs = (align ? msUntilNext15mBoundary() : 0) + initialDelayMs;
    logger.info(
        `redeem-proxy loop enabled intervalMs=${intervalMs} initialDelayMs=${initialDelayMs} align=${align} (first run in ${Math.ceil(
            waitMs / 1000
        )}s) dryRun=${dryRun} maxRetries=${maxRetries}`
    );
    await runOnce();
    setInterval(() => void runOnce(), intervalMs);
}

main().catch((error) => {
    logger.error("Fatal error in redeem-proxy", error);
    process.exit(1);
});

