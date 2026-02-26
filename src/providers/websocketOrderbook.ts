import WebSocket from "ws";
import { logger } from "../utils/logger";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { ApiKeyCreds } from "@polymarket/clob-client";

const MARKET_CHANNEL = "market";
const USER_CHANNEL = "user";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com";
const PING_INTERVAL_MS = 10000; // 10 seconds

export interface OrderBookLevel {
    price: string;
    size: string;
}

export interface OrderBookSnapshot {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
}

export interface TokenPrice {
    tokenId: string;
    bestBid: number | null;
    bestAsk: number | null;
    mid: number | null;
    timestamp: number;
}

type PriceUpdateCallback = (tokenId: string, price: TokenPrice) => void;

export class WebSocketOrderBook {
    private ws: WebSocket | null = null;
    private channelType: typeof MARKET_CHANNEL | typeof USER_CHANNEL;
    private url: string;
    private assetIds: string[];
    private auth: ApiKeyCreds | null;
    private priceCallbacks: Map<string, PriceUpdateCallback> = new Map();
    private tokenPrices: Map<string, TokenPrice> = new Map();
    public subscribedAssetIds: Set<string> = new Set();
    private tokenLabels: Map<string, string> = new Map(); // Map tokenId to "Up" or "Down"
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 20;
    private reconnectDelayMs = 0; // Reconnect immediately on disconnect
    private pingInterval: NodeJS.Timeout | null = null;
    private isConnected = false;
    private shouldReconnect = true;

    constructor(
        channelType: typeof MARKET_CHANNEL | typeof USER_CHANNEL,
        assetIds: string[],
        auth: ApiKeyCreds | null = null
    ) {
        this.channelType = channelType;
        this.url = WS_URL;
        this.assetIds = assetIds;
        this.auth = auth;
    }

    /**
     * Subscribe to price updates for a token
     */
    onPriceUpdate(tokenId: string, callback: PriceUpdateCallback): void {
        this.priceCallbacks.set(tokenId, callback);

        // If we already have a price for this token, call callback immediately
        const existingPrice = this.tokenPrices.get(tokenId);
        if (existingPrice) {
            callback(tokenId, existingPrice);
        }
    }

    /**
     * Remove price update callback for a token
     */
    offPriceUpdate(tokenId: string): void {
        this.priceCallbacks.delete(tokenId);
    }

    /**
     * Set label for a token (e.g., "Up" or "Down")
     */
    setTokenLabel(tokenId: string, label: string): void {
        this.tokenLabels.set(tokenId, label);
    }

    /**
     * Get current price for a token
     */
    getPrice(tokenId: string): TokenPrice | null {
        return this.tokenPrices.get(tokenId) || null;
    }

    /**
     * Subscribe to additional asset IDs
     */
    subscribeToTokenIds(assetIds: string[]): void {
        if (this.channelType !== MARKET_CHANNEL) {
            logger.error("subscribeToTokenIds only works for MARKET channel");
            return;
        }

        const newIds = assetIds.filter(id => !this.subscribedAssetIds.has(id));
        if (newIds.length === 0) return;

        newIds.forEach(id => this.subscribedAssetIds.add(id));

        if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(
                JSON.stringify({
                    assets_ids: newIds,
                    operation: "subscribe",
                    custom_feature_enabled: true, // Enable best_bid_ask messages
                })
            );
            logger.info(`Subscribed to ${newIds.length} new token(s) (custom_feature_enabled: true)`);
        } else {
            // Will subscribe when connection opens
            this.assetIds.push(...newIds);
        }
    }

    /**
     * Unsubscribe from asset IDs
     */
    unsubscribeFromTokenIds(assetIds: string[]): void {
        if (this.channelType !== MARKET_CHANNEL) {
            logger.error("unsubscribeFromTokenIds only works for MARKET channel");
            return;
        }

        assetIds.forEach(id => this.subscribedAssetIds.delete(id));

        if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(
                JSON.stringify({
                    assets_ids: assetIds,
                    operation: "unsubscribe",
                })
            );
            logger.info(`Unsubscribed from ${assetIds.length} token(s)`);
        }
    }

    /**
     * Connect to WebSocket
     */
    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const fullUrl = `${this.url}/ws/${this.channelType}`;
            logger.info(`Connecting to WebSocket: ${fullUrl}`);

            this.ws = new WebSocket(fullUrl);

            this.ws.on("open", () => {
                logger.info(`WebSocket connected (${this.channelType} channel)`);
                this.isConnected = true;
                this.reconnectAttempts = 0;

                // Send initial subscription
                if (this.channelType === MARKET_CHANNEL) {
                    // CRITICAL: Resubscribe to ALL previously subscribed tokens (not just initial assetIds)
                    // This ensures we resume monitoring the current market after reconnection
                    const tokensToResubscribe = Array.from(this.subscribedAssetIds);
                    
                    // If subscribedAssetIds is empty (first connection), use initial assetIds
                    const tokensToSubscribe = tokensToResubscribe.length > 0 
                        ? tokensToResubscribe 
                        : this.assetIds;
                    
                    // Ensure all tokens are in subscribedAssetIds
                    tokensToSubscribe.forEach(id => this.subscribedAssetIds.add(id));
                    
                    if (tokensToSubscribe.length > 0) {
                        this.ws!.send(
                            JSON.stringify({
                                assets_ids: tokensToSubscribe,
                                type: MARKET_CHANNEL,
                                custom_feature_enabled: true, // Enable best_bid_ask messages
                            })
                        );
                        logger.info(`Subscribed to ${tokensToSubscribe.length} token(s) for best_bid_ask updates (custom_feature_enabled: true)`);
                    } else {
                        logger.info(`Subscribed to 0 token(s) for best_bid_ask updates (custom_feature_enabled: true)`);
                    }
                } else if (this.channelType === USER_CHANNEL && this.auth) {
                    this.ws!.send(
                        JSON.stringify({
                            markets: this.assetIds, // For user channel, this might be condition_ids
                            type: USER_CHANNEL,
                            auth: {
                                apiKey: this.auth.key,
                                secret: this.auth.secret,
                                passphrase: this.auth.passphrase,
                            },
                        })
                    );
                }

                // Start ping interval
                this.startPingInterval();

                resolve();
            });

            this.ws.on("message", (data: WebSocket.Data) => {
                this.handleMessage(data);
            });

            this.ws.on("error", (error: Error) => {
                logger.error(`WebSocket error: ${error.message}`);
                this.isConnected = false;
                if (this.reconnectAttempts === 0) {
                    reject(error);
                }
            });

            this.ws.on("close", (code: number, reason: Buffer) => {
                logger.error(`WebSocket closed: ${code} ${reason.toString()}`);
                this.isConnected = false;
                this.stopPingInterval();

                if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    const delay = this.reconnectDelayMs;
                    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                    setTimeout(() => {
                        this.connect().catch((err) => {
                            logger.error(`Reconnection failed: ${err.message}`);
                        });
                    }, delay);
                } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    logger.error("Max reconnection attempts reached");
                }
            });
        });
    }

    /**
     * Handle incoming WebSocket messages
     */
    private handleMessage(data: WebSocket.Data): void {
        try {
            const message = data.toString();

            // Handle ping/pong (fast path)
            if (message === "PING") {
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send("PONG");
                }
                return;
            }

            if (message === "PONG") {
                return; // Server acknowledged ping
            }

            const parsed = JSON.parse(message);

            // Handle best_bid_ask messages (primary message type)
            if (parsed.event_type === "best_bid_ask") {
                this.handleBestBidAsk(parsed);
                return;
            }

            // Handle legacy orderbook updates (fallback)
            if (parsed.type === "l2_orderbook" || parsed.type === "orderbook") {
                this.handleOrderBookUpdate(parsed);
                return;
            }

            // Handle subscription confirmation
            if (parsed.type === "subscription_success" || parsed.event_type === "subscription_success") {
                // Silent success - no logging needed for performance
                return;
            }

            // Handle errors
            if (parsed.type === "error" || parsed.event_type === "error") {
                logger.error(`WebSocket error: ${parsed.message || JSON.stringify(parsed)}`);
                return;
            }

            // Log unknown message types only in debug mode
            if (config.debug) {
                logger.debug(`Unknown message type: ${parsed.event_type || parsed.type || "unknown"}`);
            }
        } catch (error) {
            logger.error(`Error parsing WebSocket message: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Handle best_bid_ask message (optimized for speed)
     */
    private handleBestBidAsk(message: any): void {
        const assetId = message.asset_id;
        if (!assetId) return;

        // Parse prices directly from message (faster than orderbook parsing)
        const bestBidStr = message.best_bid;
        const bestAskStr = message.best_ask;

        let bestBid: number | null = null;
        let bestAsk: number | null = null;

        // Fast parsing - only parse if strings exist
        if (bestBidStr) {
            const bid = parseFloat(bestBidStr);
            if (Number.isFinite(bid)) bestBid = bid;
        }

        if (bestAskStr) {
            const ask = parseFloat(bestAskStr);
            if (Number.isFinite(ask)) bestAsk = ask;
        }

        // Calculate mid price (optimized)
        let mid: number | null = null;
        if (bestBid !== null && bestAsk !== null) {
            mid = (bestBid + bestAsk) * 0.5; // Multiplication is faster than division
        } else if (bestBid !== null) {
            mid = bestBid;
        } else if (bestAsk !== null) {
            mid = bestAsk;
        }

        // Use timestamp from message if available, otherwise use current time
        const timestamp = message.timestamp ? parseInt(message.timestamp, 10) : Date.now();

        // Log ask price only (simplified format)
        if (bestAsk !== null) {
            const label = this.tokenLabels.get(assetId) || "Unknown";
            if (label === "Up")
                logger.info(`📊 ${label} Ask ==========> ${bestAsk.toFixed(4)}`);
            else if (label === "Down")
                logger.info(`📊 ${label} Ask ${bestAsk.toFixed(4)}`);
        }

        const price: TokenPrice = {
            tokenId: assetId,
            bestBid,
            bestAsk,
            mid,
            timestamp,
        };

        // Update cache (fast Map operation)
        this.tokenPrices.set(assetId, price);

        // Notify callback if exists (avoid Map lookup if no callback)
        const callback = this.priceCallbacks.get(assetId);
        if (callback) {
            callback(assetId, price);
        }
    }

    /**
     * Handle orderbook update message (legacy fallback)
     */
    private handleOrderBookUpdate(message: any): void {
        const assetId = message.asset_id || message.token_id;
        if (!assetId) return;

        // Extract best bid and ask
        let bestBid: number | null = null;
        let bestAsk: number | null = null;

        if (message.bids && Array.isArray(message.bids) && message.bids.length > 0) {
            const topBid = message.bids[0];
            bestBid = parseFloat(topBid.price || topBid[0]);
        }

        if (message.asks && Array.isArray(message.asks) && message.asks.length > 0) {
            const topAsk = message.asks[0];
            bestAsk = parseFloat(topAsk.price || topAsk[0]);
        }

        // Calculate mid price
        let mid: number | null = null;
        if (bestBid !== null && bestAsk !== null && Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
            mid = (bestBid + bestAsk) * 0.5;
        } else if (bestBid !== null && Number.isFinite(bestBid)) {
            mid = bestBid;
        } else if (bestAsk !== null && Number.isFinite(bestAsk)) {
            mid = bestAsk;
        }

        const price: TokenPrice = {
            tokenId: assetId,
            bestBid,
            bestAsk,
            mid,
            timestamp: Date.now(),
        };

        // Update cache
        this.tokenPrices.set(assetId, price);

        // Notify callbacks
        const callback = this.priceCallbacks.get(assetId);
        if (callback) {
            callback(assetId, price);
        }
    }

    /**
     * Start ping interval to keep connection alive
     */
    private startPingInterval(): void {
        this.stopPingInterval();
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send("PING");
            }
        }, PING_INTERVAL_MS);
    }

    /**
     * Stop ping interval
     */
    private stopPingInterval(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    /**
     * Disconnect WebSocket
     */
    disconnect(): void {
        this.shouldReconnect = false;
        this.stopPingInterval();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        logger.info("WebSocket disconnected");
    }

    /**
     * Check if WebSocket is connected
     */
    isReady(): boolean {
        return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
    }
}

/**
 * Get WebSocket orderbook client for market data
 */
let cachedOrderBookClient: WebSocketOrderBook | null = null;

export async function getWebSocketOrderBook(
    assetIds: string[],
    auth?: ApiKeyCreds
): Promise<WebSocketOrderBook> {
    // Load auth if not provided
    let apiKeyCreds: ApiKeyCreds | null = auth || null;

    if (!apiKeyCreds) {
        const credentialPath = resolve(process.cwd(), "src/data/credential.json");
        if (existsSync(credentialPath)) {
            const creds = JSON.parse(readFileSync(credentialPath, "utf-8"));
            const secretBase64 = creds.secret.replace(/-/g, '+').replace(/_/g, '/');
            apiKeyCreds = {
                key: creds.key,
                secret: secretBase64,
                passphrase: creds.passphrase,
            };
        }
    }

    // Create new client if needed
    if (!cachedOrderBookClient || !cachedOrderBookClient.isReady()) {
        cachedOrderBookClient = new WebSocketOrderBook(MARKET_CHANNEL, assetIds, apiKeyCreds);
        await cachedOrderBookClient.connect();
    } else {
        // Subscribe to new asset IDs if needed
        const newIds = assetIds.filter(id => !cachedOrderBookClient!.subscribedAssetIds.has(id));
        if (newIds.length > 0) {
            cachedOrderBookClient.subscribeToTokenIds(newIds);
        }
    }

    return cachedOrderBookClient;
}

// Import config for debug flag
import { config } from "../config";

