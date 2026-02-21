import { Chain, getContractConfig } from "@polymarket/clob-client";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";
import { BigNumber } from "@ethersproject/bignumber";
import { config } from "../config";

const ERC20_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

function getRpcUrl(chainId: number): string {
    const explicit = config.rpcUrl;
    if (explicit) return explicit;

    const rpcToken = config.rpcToken;

    if (chainId === 137) {
        if (rpcToken) return `https://polygon-mainnet.g.alchemy.com/v2/${rpcToken}`;
        return "https://polygon-rpc.com";
    }

    if (chainId === 80002) {
        if (rpcToken) return `https://polygon-amoy.g.alchemy.com/v2/${rpcToken}`;
        return "https://rpc-amoy.polygon.technology";
    }

    throw new Error(`Unsupported chain ID: ${chainId}. Supported: 137 (Polygon), 80002 (Amoy)`);
}

function formatUnits(value: BigNumber, decimals: number): number {
    // Avoid pulling in extra deps; USDC is 6 decimals on Polygon.
    const s = value.toString();
    if (decimals <= 0) return Number(s);
    const pad = decimals + 1;
    const padded = s.length < pad ? s.padStart(pad, "0") : s;
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals);
    return parseFloat(`${intPart}.${fracPart}`);
}

/**
 * Get USDC balance (as a number) for an address using on-chain ERC20 balanceOf.
 */
export async function getUsdcBalance(
    address: string,
    chainId?: Chain
): Promise<number> {
    const chainIdValue = chainId || ((config.chainId || Chain.POLYGON) as Chain);
    const rpcUrl = getRpcUrl(chainIdValue);
    const provider = new JsonRpcProvider(rpcUrl);
    const contractConfig = getContractConfig(chainIdValue);

    const usdc = new Contract(contractConfig.collateral, ERC20_ABI, provider);
    const [rawBalance, decimals] = await Promise.all([
        usdc.balanceOf(address) as Promise<BigNumber>,
        usdc.decimals() as Promise<number>,
    ]);

    return formatUnits(rawBalance, decimals);
}


