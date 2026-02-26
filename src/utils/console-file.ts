import fs from "fs";
import path from "path";
import { logger } from "./logger";

type SetupOptions = {
    /**
     * Absolute or relative file path (relative to process.cwd()).
     * If provided, this will be used as-is (single file, no rotation unless it contains "{date}").
     * Examples:
     * - "logs/bot.log"
     * - "logs/bot-{date}.log"  // daily
     */
    logFilePath?: string;

    /**
     * Directory for daily logs (relative to process.cwd()).
     * Used when logFilePath is not provided.
     */
    logDir?: string;

    /**
     * Filename prefix for daily logs when logFilePath is not provided.
     * Example: "bot" => "bot-YYYY-MM-DD.log"
     */
    filePrefix?: string;

    /**
     * If true, use UTC date for log rotation / naming. Default: false (local time).
     */
    useUtc?: boolean;
};

function toStringChunk(chunk: any, encoding?: BufferEncoding): string {
    if (Buffer.isBuffer(chunk)) return chunk.toString(encoding || "utf8");
    return typeof chunk === "string" ? chunk : String(chunk);
}

// Strip ANSI escape codes (colors, cursor control, etc) so log files stay clean.
// Example sequences: \u001b[33m ... \u001b[39m
function stripAnsi(input: string): string {
    // CSI sequences: ESC [ ... command
    // OSC sequences: ESC ] ... BEL (or ESC \)
    return input
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function dateStamp(d: Date, useUtc: boolean): string {
    const yyyy = useUtc ? d.getUTCFullYear() : d.getFullYear();
    const mm = useUtc ? d.getUTCMonth() + 1 : d.getMonth() + 1;
    const dd = useUtc ? d.getUTCDate() : d.getDate();
    return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
}

function resolveLogFilePath(options: SetupOptions, now: Date): string {
    const useUtc = options.useUtc ?? false;
    const stamp = dateStamp(now, useUtc);

    const fromEnvOrUser = options.logFilePath?.trim();
    if (fromEnvOrUser) {
        // Avoid String.prototype.replaceAll for older Node compatibility.
        const withDate = fromEnvOrUser.split("{date}").join(stamp);
        return path.isAbsolute(withDate) ? withDate : path.resolve(process.cwd(), withDate);
    }

    const logDir = (options.logDir || "logs").trim() || "logs";
    const prefix = (options.filePrefix || "bot").trim() || "bot";
    const dailyName = `${prefix}-${stamp}.log`;
    const resolvedDir = path.isAbsolute(logDir) ? logDir : path.resolve(process.cwd(), logDir);
    return path.join(resolvedDir, dailyName);
}

/**
 * Tee everything written to stdout/stderr into a file.
 * This captures `console.log`, `console.error`, etc.
 */
export function setupConsoleFileLogging(options: SetupOptions): void {
    const useUtc = options.useUtc ?? false;
    let currentDate = dateStamp(new Date(), useUtc);
    let currentPath = resolveLogFilePath(options, new Date());

    const ensureDir = (p: string) => {
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
        } catch {
            // ignore
        }
    };

    let stream: fs.WriteStream | null = null;

    const openStream = (p: string) => {
        ensureDir(p);
        const s = fs.createWriteStream(p, { flags: "a" });
        s.write(`\n\n\n\n\n===== LOG START ${new Date().toISOString()} pid=${process.pid} =====\n\n\n\n\n`);
        return s;
    };

    try {
        stream = openStream(currentPath);
    } catch (e) {
        // If file logging can't start, do nothing (avoid crashing bot).
        logger.error(
            `Failed to set up file logging at ${currentPath}: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
    }

    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    const rotateIfNeeded = () => {
        // Rotate only when using daily naming (default) or when logFilePath contains "{date}"
        const configuredPath = options.logFilePath?.trim() || "";
        const shouldRotate =
            !configuredPath || configuredPath.includes("{date}");

        if (!shouldRotate) return;

        const now = new Date();
        const nextDate = dateStamp(now, useUtc);
        if (nextDate === currentDate) return;

        currentDate = nextDate;
        currentPath = resolveLogFilePath(options, now);

        try {
            stream?.write(
                `\n===== LOG ROTATE ${now.toISOString()} -> ${currentPath} =====\n`
            );
            stream?.end();
        } catch {
            // ignore
        }

        try {
            stream = openStream(currentPath);
        } catch {
            // If rotation fails, keep going without file writes (but preserve console output).
            stream = null;
        }
    };

    // Patch stdout
    (process.stdout.write as any) = (
        chunk: any,
        encoding?: BufferEncoding,
        cb?: (err?: Error | null) => void
    ) => {
        try {
            rotateIfNeeded();
            const raw = toStringChunk(chunk, encoding);
            stream?.write(stripAnsi(raw));
        } catch {
            // ignore file write errors
        }
        return origStdoutWrite(chunk, encoding as any, cb as any);
    };

    // Patch stderr
    (process.stderr.write as any) = (
        chunk: any,
        encoding?: BufferEncoding,
        cb?: (err?: Error | null) => void
    ) => {
        try {
            rotateIfNeeded();
            const raw = toStringChunk(chunk, encoding);
            stream?.write(stripAnsi(raw));
        } catch {
            // ignore file write errors
        }
        return origStderrWrite(chunk, encoding as any, cb as any);
    };

    // Best-effort flush on exit
    const close = () => {
        try {
            stream?.write(
                `\n===== LOG END ${new Date().toISOString()} pid=${process.pid} =====\n`
            );
            stream?.end();
        } catch {
            // ignore
        }
    };

    process.once("exit", close);
    process.once("SIGINT", () => {
        close();
        process.exit(0);
    });
    process.once("SIGTERM", () => {
        close();
        process.exit(0);
    });
}


