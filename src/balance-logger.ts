#!/usr/bin/env node
import { logger } from "./utils/logger";
import { config } from "./config";
import { Wallet } from "ethers";
import { getClobClient } from "./providers/clobclient";
import { AssetType } from "@polymarket/clob-client";
import * as fs from "fs";
import * as path from "path";

const BALANCE_LOG_FILE = "logs/balance.log";

/**
 * Get USDC balance in decimal format (not wei)
 */
async function getUsdcBalance(walletAddress: string): Promise<number> {
    try {
        const client = await getClobClient();
        if (!client) {
            throw new Error("Failed to get CLOB client");
        }
        
        const balanceResponse = await client.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
        });
        const balance = parseFloat(balanceResponse.balance || "0");
        return balance / 10 ** 6; // Convert from wei to USDC
    } catch (error) {
        logger.error(`Failed to get USDC balance: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
    }
}

/**
 * Ensure balance log file exists
 */
function ensureBalanceLogExists(): void {
    const logPath = path.resolve(process.cwd(), BALANCE_LOG_FILE);
    const logDir = path.dirname(logPath);
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Create log file if it doesn't exist
    if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, "", "utf8");
        logger.info(`Created balance log file: ${BALANCE_LOG_FILE}`);
    }
}

/**
 * Append a line to the balance log file
 */
function appendBalanceLogLine(line: string): void {
    const logPath = path.resolve(process.cwd(), BALANCE_LOG_FILE);
    fs.appendFileSync(logPath, line + "\n", "utf8");
}

/**
 * Get current 15-minute market slug
 */
function getCurrentMarketSlug(): string {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(Math.floor(d.getMinutes() / 15) * 15);
    return `market-${Math.floor(d.getTime() / 1000)}`;
}

/**
 * Calculate milliseconds until next 15-minute boundary
 */
function msUntilNext15mBoundary(now: Date = new Date()): number {
    const d = new Date(now);
    d.setSeconds(0, 0);
    const m = d.getMinutes();
    const nextMin = (Math.floor(m / 15) + 1) * 15;
    d.setMinutes(nextMin, 0, 0);
    return Math.max(0, d.getTime() - now.getTime());
}

/**
 * Get next 15-minute boundary timestamp
 */
function getNext15mBoundary(now: Date = new Date()): Date {
    const d = new Date(now);
    d.setSeconds(0, 0);
    const m = d.getMinutes();
    const nextMin = (Math.floor(m / 15) + 1) * 15;
    d.setMinutes(nextMin, 0, 0);
    return d;
}

/**
 * Log balance for current market
 */
async function logBalanceForMarket(): Promise<void> {
    try {
        const privateKey = config.requirePrivateKey();
        const wallet = new Wallet(privateKey);
        const walletAddress = wallet.address;
        
        const balance = await getUsdcBalance(walletAddress);
        const marketSlug = getCurrentMarketSlug();
        const timestamp = new Date().toISOString();
        
        const logLine = `${timestamp} ${marketSlug} balance=${balance.toFixed(6)}`;
        appendBalanceLogLine(logLine);
        
        logger.success(`💰 Balance logged: ${balance.toFixed(6)} USDC (${marketSlug})`);
    } catch (error) {
        logger.error(`Failed to log balance: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Main function
 */
async function main(): Promise<void> {
    logger.info("═══════════════════════════════════════════════════");
    logger.info("💰 Balance Logger Started");
    logger.info("═══════════════════════════════════════════════════");
    logger.info(`Log file: ${BALANCE_LOG_FILE}`);
    logger.info(`Wallet: ${new Wallet(config.requirePrivateKey()).address}`);
    logger.info("═══════════════════════════════════════════════════");
    
    // Ensure log file exists
    ensureBalanceLogExists();
    
    // Parse command-line arguments
    const args = process.argv.slice(2);
    const isOnce = args.includes("--once");
    
    if (isOnce) {
        // Run once and exit
        logger.info("Running once (--once flag)");
        await logBalanceForMarket();
        logger.info("Balance logged successfully. Exiting.");
        return;
    }
    
    // Wait for next 15-minute boundary
    const msUntilNext = msUntilNext15mBoundary();
    const nextBoundary = getNext15mBoundary();
    
    logger.info(`⏰ Waiting for next 15-minute boundary...`);
    logger.info(`   Current time: ${new Date().toISOString()}`);
    logger.info(`   Next boundary: ${nextBoundary.toISOString()}`);
    logger.info(`   Wait time: ${Math.ceil(msUntilNext / 1000)}s`);
    
    await new Promise(resolve => setTimeout(resolve, msUntilNext));
    
    // Log balance at this boundary
    await logBalanceForMarket();
    
    // Set up interval to log every 15 minutes
    const intervalMs = 15 * 60 * 1000; // 15 minutes
    setInterval(async () => {
        await logBalanceForMarket();
    }, intervalMs);
    
    logger.info(`✅ Balance logger running (every 15 minutes)`);
    logger.info(`   Next log at: ${new Date(Date.now() + intervalMs).toISOString()}`);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
    logger.info("\n🛑 Balance logger stopped (SIGINT)");
    process.exit(0);
});

process.on("SIGTERM", () => {
    logger.info("\n🛑 Balance logger stopped (SIGTERM)");
    process.exit(0);
});

// Run main function
main().catch((error) => {
    logger.error("Fatal error in balance logger", error);
    process.exit(1);
});

