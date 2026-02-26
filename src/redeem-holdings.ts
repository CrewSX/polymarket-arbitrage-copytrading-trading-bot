/**
 * Standalone redemption runner (does NOT start the trading bot).
 *
 * Uses `src/data/token-holding.json` (written by the bot) and redeems any markets that are resolved.
 *
 * Usage:
 *   ts-node src/redeem-holdings.ts
 *   ts-node src/redeem-holdings.ts --dry-run
 *   ts-node src/redeem-holdings.ts --loop --interval-ms 30000
 */

import { autoRedeemResolvedMarkets, checkConditionResolution } from "./utils/redeem";
import { logger } from "./utils/logger";
import { clearMarketHoldings } from "./utils/holdings";
import { config } from "./config";
import { getUsdcBalance } from "./utils/usdcBalance";
import { Wallet } from "@ethersproject/wallet";
import fs from "fs";
import path from "path";

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

type CopytradeStateRow = {
    qtyYES: number;
    qtyNO: number;
    costYES: number;
    costNO: number;
    buysCount: number;
    lastUpdatedIso: string;
    conditionId?: string;
    slug?: string;
    market?: string;
    upIdx?: number;
    downIdx?: number;
};

type CopytradeStateFile = Record<string, CopytradeStateRow>;

function copytradeStatePath(): string {
    // Use project-root-relative path so this works even if process cwd differs (e.g., pm2).
    // `__dirname` here is `<projectRoot>/src` when running via ts-node.
    return path.resolve(__dirname, "..", "src/data/copytrade-state.json");
}

function pnlLogPath(): string {
    const dir = config.logging.logDir || "logs";
    return path.resolve(__dirname, "..", dir, "pnl.log");
}

function appendPnlLogLine(line: string): void {
    const p = pnlLogPath();
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, line.endsWith("\n") ? line : `${line}\n`, "utf8");
    } catch (e) {
        logger.error(`Failed to append pnl.log: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function ensurePnlLogExists(): void {
    const p = pnlLogPath();
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (!fs.existsSync(p)) {
            fs.writeFileSync(p, "", "utf8");
        }
    } catch (e) {
        logger.error(`Failed to ensure pnl.log exists: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function loadCopytradeStateFile(): CopytradeStateFile {
    const p = copytradeStatePath();
    if (!fs.existsSync(p)) return {};
    try {
        const raw = fs.readFileSync(p, "utf8").trim();
        if (!raw) return {};
        return JSON.parse(raw) as CopytradeStateFile;
    } catch (e) {
        logger.error(`Failed to read copytrade-state.json for pnl: ${e instanceof Error ? e.message : String(e)}`);
        return {};
    }
}

function pickBestStateRowForConditionId(
    state: CopytradeStateFile,
    conditionId: string
): { key: string; row: CopytradeStateRow } | null {
    let best: { key: string; row: CopytradeStateRow; score: number } | null = null;
    for (const [key, row] of Object.entries(state)) {
        if (!row || row.conditionId !== conditionId) continue;
        const score = Date.parse(row.lastUpdatedIso || "") || 0;
        if (!best || score > best.score) best = { key, row, score };
    }
    return best ? { key: best.key, row: best.row } : null;
}

async function recordPnlForRedeemedCondition(conditionId: string, balanceAfterRedeem?: number): Promise<void> {
    const state = loadCopytradeStateFile();
    const picked = pickBestStateRowForConditionId(state, conditionId);
    if (!picked) {
        const balanceStr = balanceAfterRedeem !== undefined ? ` balance=${balanceAfterRedeem.toFixed(6)}` : "";
        appendPnlLogLine(
            `${new Date().toISOString()} slug=? market=? conditionId=${conditionId} pnl=? cost=? payout=? note=no_state_row${balanceStr}`
        );
        return;
    }

    const { key, row } = picked;
    const slug = row.slug || key.replace(/^copytrade:/, "");
    const market = row.market || slug.split("-")[0] || "?";
    const cost = (row.costYES || 0) + (row.costNO || 0);

    const resolution = await checkConditionResolution(conditionId);
    if (!resolution.isResolved) {
        const balanceStr = balanceAfterRedeem !== undefined ? ` balance=${balanceAfterRedeem.toFixed(6)}` : "";
        appendPnlLogLine(
            `${new Date().toISOString()} slug=${slug} market=${market} conditionId=${conditionId} pnl=? cost=${cost.toFixed(
                6
            )} payout=? note=not_resolved${balanceStr}`
        );
        return;
    }

    const denom = Number(resolution.payoutDenominator.toString());
    const upIdx = Number.isFinite(Number(row.upIdx)) ? Number(row.upIdx) : 0;
    const downIdx = Number.isFinite(Number(row.downIdx)) ? Number(row.downIdx) : 1;
    const upNum = Number(resolution.payoutNumerators[upIdx]?.toString() ?? "0");
    const downNum = Number(resolution.payoutNumerators[downIdx]?.toString() ?? "0");
    const upRatio = denom > 0 ? upNum / denom : 0;
    const downRatio = denom > 0 ? downNum / denom : 0;

    const payout = (row.qtyYES || 0) * upRatio + (row.qtyNO || 0) * downRatio;
    const pnl = payout - cost;

    const logParts = [
        new Date().toISOString(),
        `slug=${slug}`,
        `market=${market}`,
        `conditionId=${conditionId}`,
        `pnl=${pnl.toFixed(6)}`,
        `payout=${payout.toFixed(6)}`,
        `cost=${cost.toFixed(6)}`,
        `qtyYES=${Number(row.qtyYES || 0).toFixed(6)}`,
        `qtyNO=${Number(row.qtyNO || 0).toFixed(6)}`,
        `winners=${resolution.winningIndexSets.join(",") || "?"}`,
    ];
    
    if (balanceAfterRedeem !== undefined) {
        logParts.push(`balance=${balanceAfterRedeem.toFixed(6)}`);
    }

    appendPnlLogLine(logParts.join(" "));
}

function extractStartSecFromCopytradeKey(key: string): number | null {
    // key format: copytrade:<market>-updown-15m-<startSec>
    const match = key.match(/-(\d{9,})$/);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : null;
}

function pruneCopytradeStateKeepNewest(keep: number): void {
    const p = copytradeStatePath();
    if (!fs.existsSync(p)) return;

    let state: CopytradeStateFile;
    try {
        const raw = fs.readFileSync(p, "utf8").trim();
        if (!raw) return;
        state = JSON.parse(raw) as CopytradeStateFile;
    } catch (e) {
        logger.error(`Failed to read copytrade-state.json for pruning: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }

    const keys = Object.keys(state);
    if (keys.length <= keep) return;

    const scored = keys.map((k) => {
        const startSec = extractStartSecFromCopytradeKey(k);
        const iso = state[k]?.lastUpdatedIso;
        const isoMs = iso ? Date.parse(iso) : NaN;
        // Prefer startSec (market start), fallback to lastUpdatedIso
        const score = startSec !== null ? startSec * 1000 : (Number.isFinite(isoMs) ? isoMs : 0);
        return { k, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const keepSet = new Set(scored.slice(0, Math.max(0, keep)).map((x) => x.k));

    let removed = 0;
    const pruned: CopytradeStateFile = {};
    for (const k of scored.map((x) => x.k)) {
        if (keepSet.has(k)) pruned[k] = state[k];
        else removed++;
    }

    if (removed <= 0) return;
    try {
        fs.writeFileSync(p, JSON.stringify(pruned, null, 2));
        logger.info(`Pruned copytrade-state.json removed=${removed} kept=${Object.keys(pruned).length}`);
    } catch (e) {
        logger.error(`Failed to write pruned copytrade-state.json: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const loop = args.includes("--loop") || !args.includes("--once");
    const intervalMs = Number(getArgValue(args, "--interval-ms") ?? "200000"); // 15m
    const maxRetries = Number(getArgValue(args, "--max-retries") ?? "3");
    const initialDelayMs = Number(getArgValue(args, "--initial-delay-ms") ?? "200000"); // 200s
    const align = !(args.includes("--no-align"));
    const keepState = Number(getArgValue(args, "--keep-state") ?? "4");

    if (!dryRun) {
        // Make sure the file exists as soon as the process starts (even before the first runOnce).
        ensurePnlLogExists();
    }

    let running = false;
    const runOnce = async () => {
        if (running) return;
        running = true;
        try {
            const result = await autoRedeemResolvedMarkets({
                dryRun,
                maxRetries,
            });

            // Record realized PnL for redeemed markets (append-only).
            if (!dryRun) {
                let wroteAny = false;
                // Get wallet address once for balance checks
                let walletAddress: string | null = null;
                try {
                    const privateKey = config.requirePrivateKey();
                    const wallet = new Wallet(privateKey);
                    walletAddress = wallet.address;
                } catch (e) {
                    logger.error(`Failed to get wallet address for balance logging: ${e instanceof Error ? e.message : String(e)}`);
                }

                for (const r of result.results) {
                    if (r.isResolved && r.redeemed) {
                        try {
                            // Get wallet balance after redemption
                            let balanceAfterRedeem: number | undefined;
                            if (walletAddress) {
                                try {
                                    balanceAfterRedeem = await getUsdcBalance(walletAddress);
                                } catch (e) {
                                    logger.error(
                                        `Failed to get balance after redeem for conditionId=${r.conditionId}: ${
                                            e instanceof Error ? e.message : String(e)
                                        }`
                                    );
                                }
                            }
                            await recordPnlForRedeemedCondition(r.conditionId, balanceAfterRedeem);
                            wroteAny = true;
                        } catch (e) {
                            logger.error(
                                `Failed to record pnl for conditionId=${r.conditionId}: ${
                                    e instanceof Error ? e.message : String(e)
                                }`
                            );
                        }
                    }
                }
                // If nothing redeemed this run, still leave a breadcrumb so the file is visibly updating.
                if (!wroteAny) {
                    appendPnlLogLine(
                        `${new Date().toISOString()} slug=? market=? conditionId=? pnl=? cost=? payout=? note=no_redeems total=${result.total} resolved=${result.resolved} redeemed=${result.redeemed} failed=${result.failed}`
                    );
                }
            }

            // If the market is resolved but we hold only losing tokens, redemption fails with:
            // "You don't hold any winning tokens. You hold: X, Winners: Y"
            // In this case, remove the conditionId from token-holding.json to avoid repeated attempts.
            for (const r of result.results) {
                if (r.isResolved && !r.redeemed && shouldDropHoldingsForError(r.error)) {
                    logger.error(
                        `Dropping holdings for conditionId=${r.conditionId} (no winning tokens to redeem)`
                    );
                    try {
                        clearMarketHoldings(r.conditionId);
                    } catch (e) {
                        logger.error(`Failed to clear holdings for ${r.conditionId}`, e);
                    }
                }
            }

            // Keep copytrade state file small so bot startup stays fast.
            // Prune after redeem run (whether or not we redeemed anything).
            if (!dryRun) {
                pruneCopytradeStateKeepNewest(Math.max(0, keepState));
            }
        } catch (e) {
            logger.error("redeem-holdings run failed", e);
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
        `redeem-holdings loop enabled intervalMs=${intervalMs} initialDelayMs=${initialDelayMs} align=${align} keepState=${keepState} (first run in ${Math.ceil(
            waitMs / 1000
        )}s) dryRun=${dryRun} maxRetries=${maxRetries}`
    );
    // await sleep(waitMs);
    await runOnce();
    setInterval(() => void runOnce(), intervalMs);
}

main().catch((e) => {
    logger.error("Fatal error in redeem-holdings", e);
    process.exit(1);
});


