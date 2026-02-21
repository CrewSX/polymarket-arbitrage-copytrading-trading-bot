import { logger } from "./utils/logger";
import { createCredential } from "./security/createCredential";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { getClobClient } from "./providers/clobclient";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { config } from "./config";

import { CopytradeArbBot } from "./order-builder/copytrade";
import { setupConsoleFileLogging } from "./utils/console-file";

// Capture ALL console output (stdout/stderr) into a local file.
// Configure via env var:
// - LOG_FILE_PATH="logs/bot-{date}.log" (daily) or "logs/bot.log" (single file)
// - LOG_DIR="logs" and LOG_FILE_PREFIX="bot" (daily; used if LOG_FILE_PATH not set)
setupConsoleFileLogging({
    logFilePath: config.logging.logFilePath, // supports "{date}" placeholder
    logDir: config.logging.logDir,
    filePrefix: config.logging.logFilePrefix,
});

function msUntilNext15mBoundary(now: Date = new Date()): number {
    const d = new Date(now);
    d.setSeconds(0, 0);
    const m = d.getMinutes();
    const nextMin = (Math.floor(m / 15) + 1) * 15;
    d.setMinutes(nextMin, 0, 0);
    return Math.max(0, d.getTime() - now.getTime());
}

async function waitForNextMarketStart(): Promise<void> {
    const ms = msUntilNext15mBoundary();
    if (ms <= 0) return;
    logger.info(
        `Waiting for next 15m market start: ${Math.ceil(ms / 1000)}s (start at next boundary)`
    );
    await new Promise((resolve) => setTimeout(resolve, ms));
    logger.success("Next 15m market started — starting bot now");
}

async function waitMs(ms: number, label: string): Promise<void> {
    if (!(ms > 0)) return;
    logger.info(`Waiting ${Math.ceil(ms / 1000)}s ${label}...`);
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    logger.info("Starting the bot...");

    // Create credentials if they don't exist
    const credential = await createCredential();
    if (credential) {
        logger.info("Credentials ready");
    }

    const clobClient = await getClobClient();

    // Approve USDC allowances to Polymarket contracts
    if (clobClient) {
        try {
            logger.info("Approving USDC allowances to Polymarket contracts...");
            await approveUSDCAllowance();

            // Update CLOB API to sync with on-chain allowances
            logger.info("Syncing allowances with CLOB API...");
            await updateClobBalanceAllowance(clobClient);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            const code = (error as { code?: string })?.code;
            const isInsufficientFunds =
                code === "INSUFFICIENT_FUNDS" ||
                /insufficient funds/i.test(msg);
            if (isInsufficientFunds) {
                logger.error("INSUFFICIENT_FUNDS: Your wallet has no POL (MATIC) for gas.");
                logger.error("Add POL to your wallet on Polygon to run this bot: https://polygonscan.com/address/YOUR_WALLET");
                logger.warning("Continuing without allowances - orders may fail until you fund the wallet.");
            } else {
                logger.error("Failed to approve USDC allowances", error);
                logger.warning("Continuing without allowances - orders may fail");
            }
        }

        // Validation gate: proceed only once available USDC balance is >= $1
        const { ok, available, allowance, balance } = await waitForMinimumUsdcBalance(clobClient, config.bot.minUsdcBalance, {
            pollIntervalMs: 15_000,
            timeoutMs: 0, // wait indefinitely
            logEveryPoll: true,
        });
        logger.info(
            `waitForMinimumUsdcBalance ==> ok=${ok} available=${available} allowance=${allowance} balance=${balance}`
        );
        logger.success("Wallet is funded");
        // Next step:
        if (config.bot.waitForNextMarketStart) {
            await waitForNextMarketStart();
        } else {
            logger.info("Skipping wait for next 15m market start (resume immediately from state)");
        }
        // Delay trading start to allow previous market to become redeemable (~200s) and be redeemed by worker.
        const copytrade = CopytradeArbBot.fromEnv(clobClient);
        copytrade.start();
    } else {
        logger.error("Failed to initialize CLOB client - cannot continue");
        return;
    }
}

main().catch((error) => {
    logger.error("Fatal error", error);
    process.exit(1);
});
