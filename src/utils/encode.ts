import { hexZeroPad } from "@ethersproject/bytes";
import { BigNumber } from "@ethersproject/bignumber";
import { Interface } from "@ethersproject/abi";

// Conditional Tokens Framework ABI for encoding
const CTF_ABI = [
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)",
];

// Neg Risk Adapter ABI for encoding
const NEG_RISK_ABI = [
    "function redeem(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets, uint256[] calldata amounts)",
];

const CTF_INTERFACE = new Interface(CTF_ABI);
const NEG_RISK_INTERFACE = new Interface(NEG_RISK_ABI);

/**
 * Encode redeem transaction data for standard (non-neg-risk) markets
 * 
 * @param collateralToken - The collateral token address (e.g., USDC)
 * @param conditionId - The condition ID (market ID) to redeem
 * @returns Encoded transaction data
 */
export function encodeRedeem(collateralToken: string, conditionId: string): string {
    // Parent collection ID is always bytes32(0) for Polymarket
    const parentCollectionId = "0x0000000000000000000000000000000000000000000000000000000000000000";
    
    // Convert conditionId to bytes32 format
    let conditionIdBytes32: string;
    if (conditionId.startsWith("0x")) {
        // Already hex, pad to 32 bytes
        conditionIdBytes32 = hexZeroPad(conditionId, 32);
    } else {
        // Assume it's a hex string without 0x prefix
        conditionIdBytes32 = hexZeroPad(`0x${conditionId}`, 32);
    }
    
    // Default index sets for Polymarket binary markets: [1, 2] (YES and NO)
    const indexSets = [1, 2];
    
    return CTF_INTERFACE.encodeFunctionData("redeemPositions", [
        collateralToken,
        parentCollectionId,
        conditionIdBytes32,
        indexSets,
    ]);
}

/**
 * Encode redeem transaction data for neg-risk markets
 * 
 * @param conditionId - The condition ID (market ID) to redeem
 * @param amounts - Array of amounts to redeem [yesAmount, noAmount]
 * @returns Encoded transaction data
 */
export function encodeRedeemNegRisk(conditionId: string, amounts: string[]): string {
    // USDC address on Polygon
    const collateralToken = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    
    // Parent collection ID is always bytes32(0) for Polymarket
    const parentCollectionId = "0x0000000000000000000000000000000000000000000000000000000000000000";
    
    // Convert conditionId to bytes32 format
    let conditionIdBytes32: string;
    if (conditionId.startsWith("0x")) {
        // Already hex, pad to 32 bytes
        conditionIdBytes32 = hexZeroPad(conditionId, 32);
    } else {
        // Assume it's a hex string without 0x prefix
        conditionIdBytes32 = hexZeroPad(`0x${conditionId}`, 32);
    }
    
    // Default index sets for Polymarket binary markets: [1, 2] (YES and NO)
    const indexSets = [1, 2];
    
    // Convert amounts to BigNumber array
    const amountsBN = amounts.map(amt => BigNumber.from(amt));
    
    return NEG_RISK_INTERFACE.encodeFunctionData("redeem", [
        collateralToken,
        parentCollectionId,
        conditionIdBytes32,
        indexSets,
        amountsBN,
    ]);
}

