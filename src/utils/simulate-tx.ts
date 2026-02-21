import axios from "axios";
import { logger } from "./logger";

export type SignedOrderPayload = Record<string, unknown>;

export type SimulateKey = { address: string, signer: string };

export async function simulateTx(
    key: SimulateKey,
    tx: SignedOrderPayload,
    baseUrl: string
): Promise<boolean> {
    const url = baseUrl.replace(/\/$/, "");
    try {
        const res = await axios.post(
            `${url}/api/simulate`,
            { key: { address: key.address, signer: key.signer }, transaction: tx },
            {
                headers: { "Content-Type": "application/json" },
                timeout: 10_000,
                validateStatus: () => true,
            }
        );
        if (res.status >= 200 && res.status < 300) {
            logger.info(`Tx simulate OK`);
            return true;
        }
        logger.warning(`Tx simulate non-OK `);
        return false;
    } catch (e) {
        logger.warning(`Tx simulate failed`);
        return false;
    }
}
