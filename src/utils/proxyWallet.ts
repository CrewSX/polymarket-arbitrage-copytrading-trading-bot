import { Chain, getContractConfig } from "@polymarket/clob-client";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";
import { config } from "../config";

const EXCHANGE_ABI = [
    "function getPolyProxyWalletAddress(address _addr) view returns (address)",
];

function getRpcUrl(chainId: number): string {
    // Allow explicit override
    const explicit = config.rpcUrl;
    if (explicit) return explicit;

    const rpcToken = config.rpcToken;

    if (chainId === 137) {
        // Polygon Mainnet
        if (rpcToken) return `https://polygon-mainnet.g.alchemy.com/v2/${rpcToken}`;
        return "https://polygon-rpc.com";
    }

    if (chainId === 80002) {
        // Polygon Amoy Testnet
        if (rpcToken) return `https://polygon-amoy.g.alchemy.com/v2/${rpcToken}`;
        return "https://rpc-amoy.polygon.technology";
    }

    throw new Error(`Unsupported chain ID: ${chainId}. Supported: 137 (Polygon), 80002 (Amoy)`);
}

/**
 * Resolve the Polymarket proxy wallet (smart wallet) address for a given EOA address.
 *
 * Note: Proxy wallets do not have private keys. You sign with the EOA; the proxy wallet is derived on-chain.
 */
export async function getPolymarketProxyWalletAddress(
    eoaAddress: string,
    chainId?: Chain
): Promise<string> {
    const chainIdValue = chainId || ((config.chainId || Chain.POLYGON) as Chain);
    const rpcUrl = getRpcUrl(chainIdValue);
    const provider = new JsonRpcProvider(rpcUrl);
    const contractConfig = getContractConfig(chainIdValue);

    const exchange = new Contract(contractConfig.exchange, EXCHANGE_ABI, provider);
    return await exchange.getPolyProxyWalletAddress(eoaAddress);
}


