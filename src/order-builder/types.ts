import { Side, OrderType, UserMarketOrder, CreateOrderOptions } from "@polymarket/clob-client";
import type { TradePayload } from "../utils/types";

/**
 * Options for copying a trade
 */
export interface CopyTradeOptions {
    /**
     * The trade payload to copy
     */
    trade: TradePayload;

    /**
     * Multiplier for the trade size (default: 1.0)
     * Example: 0.5 = copy with 50% of the original size
     */
    sizeMultiplier?: number;

    /**
     * Maximum amount to spend on a BUY order (in USDC)
     * If not set, uses the calculated amount from size and price
     */
    maxAmount?: number;

    /**
     * Order type for market orders (default: FAK)
     */
    orderType?: OrderType.FOK | OrderType.FAK;

    /**
     * Tick size for the order (default: "0.01")
     */
    tickSize?: CreateOrderOptions["tickSize"];

    /**
     * Whether to use negRisk exchange (default: false)
     */
    negRisk?: boolean;

    /**
     * Fee rate in basis points (optional)
     */
    feeRateBps?: number;
}

/**
 * Result of placing a copied trade order
 */
export interface CopyTradeResult {
    /**
     * Whether the order was successfully placed
     */
    success: boolean;

    /**
     * Order ID if successful
     */
    orderID?: string;

    /**
     * Error message if failed
     */
    error?: string;

    /**
     * Transaction hashes
     */
    transactionHashes?: string[];

    /**
     * The market order that was created
     */
    marketOrder?: UserMarketOrder;
}

export interface IEvent {   
    id: string;
    ticker: string;
    slug: string;
    title: string;
    description: string;
    resolutionSource: string;
    startDate: string;
    creationDate: string;
    endDate: string;
    image: string;
    icon: string;
    active: boolean;
    closed: boolean;
    archived: boolean;
    new: boolean;
    featured: boolean;
    restricted: boolean;
    liquidity: number;
    volume: number;
    openInterest: number;
    createdAt: string;
    updatedAt: string;
    competitive: number;
    volume24hr: number;
    volume1wk: number;
    volume1mo: number;
    volume1yr: number;
    enableOrderBook: boolean;
    liquidityClob: number;
    negRisk: boolean;
    commentCount: number;
    cyom: boolean;
    showAllOutcomes: boolean;
    seriesSlug: string;
    negRiskAugmented: boolean;
    pendingDeployment: boolean;
    deploying: boolean;
    requiresTranslation: boolean;
}

export interface IMarketResponse {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    resolutionSource: string;
    endDate: string;
    liquidity: string;
    startDate: string;
    image: string;
    icon: string;
    description: string;
    outcomes: string;
    outcomePrices: string;
    volume: string;
    active: boolean;
    closed: boolean;
    marketMakerAddress: string;
    createdAt: string;
    updatedAt: string;
    new: boolean;
    featured: boolean;
    archived: boolean;
    restricted: boolean;
    groupItemThreshold: string;
    questionID: string;
    enableOrderBook: boolean;
    orderPriceMinTickSize: number;
    orderMinSize: number;
    volumeNum: number;
    liquidityNum: number;
    endDateIso: string;
    startDateIso: string;
    hasReviewedDates: boolean;
    volume24hr: number;
    volume1wk: number;
    volume1mo: number;
    volume1yr: number;
    clobTokenIds: string[];
    volume24hrClob: number;
    volume1wkClob: number;
    volume1moClob: number;
    volume1yrClob: number;
    volumeClob: number;
    liquidityClob: number;
    acceptingOrders: boolean;
    negRisk: boolean;
    events: IEvent[];
    ready: boolean;
    funded: boolean;
    acceptingOrdersTimestamp: string;
    cyom: boolean;
    competitive: number;
    pagerDutyNotificationEnabled: boolean;
    approved: boolean;
    rewardsMinSize: number;
    rewardsMaxSpread: number;
    clearBookOnStart: boolean;
    showGmpSeries: boolean;
    showGmpOutcome: boolean;
    manualActivation: boolean;
    negRiskOther: boolean;
    umaResolutionStatuses: string;
    pendingDeployment: boolean;
    deploying: boolean;
    rfqEnabled: boolean;
    eventStartTime: string;
    holdingRewardsEnabled: boolean;
    feesEnabled: boolean;
    requiresTranslation: boolean;
}


