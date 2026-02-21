import { ApiKeyCreds, ClobClient, Chain } from "@polymarket/clob-client";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { Wallet } from "@ethersproject/wallet";
import { logger } from "../utils/logger";
import { config } from "../config";

export async function createCredential(): Promise<ApiKeyCreds | null> {
    const privateKey = config.privateKey;
    if (!privateKey) return (logger.error("PRIVATE_KEY not found"), null);

    // Check if credentials already exist
    // const credentialPath = resolve(process.cwd(), "src/data/credential.json");
    // if (existsSync(credentialPath)) {
    //     logger.info("Credentials already exist. Returning existing credentials.");
    //     return JSON.parse(readFileSync(credentialPath, "utf-8"));
    // }

    try {
        const wallet = new Wallet(privateKey);
        logger.info(`wallet address ${wallet.address}`);
        const chainId = (config.chainId || Chain.POLYGON) as Chain;
        const host = config.clobApiUrl;

        // Create temporary ClobClient just for credential creation
        const clobClient = new ClobClient(host, chainId, wallet);
        let credential: ApiKeyCreds;

        try {
            credential = await clobClient.createOrDeriveApiKey();
        } catch (createError: unknown) {
            const msg = createError instanceof Error ? createError.message : String(createError);
            const data = (createError as { response?: { data?: { error?: string } } })?.response?.data?.error;
            const isCouldNotCreate =
                /Could not create api key/i.test(msg) ||
                (typeof data === "string" && /Could not create api key/i.test(data));
            if (isCouldNotCreate) {
                logger.info("Create api key failed (wallet may already have one), trying deriveApiKey...");
                credential = await clobClient.deriveApiKey();
            } else {
                throw createError;
            }
        }

        await saveCredential(credential);
        logger.success("Credential created successfully");
        return credential;
    } catch (error) {
        logger.error("createCredential error", error);
        logger.error(
            `Error creating credential: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}   

export async function saveCredential(credential: ApiKeyCreds) {
    const credentialPath = resolve(process.cwd(), "src/data/credential.json");
    const dir = resolve(process.cwd(), "src/data");
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(credentialPath, JSON.stringify(credential, null, 2));
}