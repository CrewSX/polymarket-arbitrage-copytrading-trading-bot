import { ApiKeyCreds, ClobClient, Chain } from "@polymarket/clob-client";
<<<<<<< HEAD
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
=======
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { resolve } from "path";
>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
import { Wallet } from "@ethersproject/wallet";
import { logger } from "../utils/logger";
import { config } from "../config";

<<<<<<< HEAD
const CREDENTIAL_PATH = resolve(process.cwd(), "src/data/credential.json");

export function credentialPath(): string {
    return CREDENTIAL_PATH;
}

export function hasCredentialFile(): boolean {
    return existsSync(CREDENTIAL_PATH);
}

/**
 * Create API key credentials via createOrDeriveApiKey and save to src/data/credential.json.
 * Ensures src/data directory exists before writing.
 */
=======
>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
export async function createCredential(): Promise<ApiKeyCreds | null> {
    const privateKey = config.privateKey;
    if (!privateKey) return (logger.error("PRIVATE_KEY not found"), null);

<<<<<<< HEAD
=======
    // Check if credentials already exist
    // const credentialPath = resolve(process.cwd(), "src/data/credential.json");
    // if (existsSync(credentialPath)) {
    //     logger.info("Credentials already exist. Returning existing credentials.");
    //     return JSON.parse(readFileSync(credentialPath, "utf-8"));
    // }

>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
    try {
        const wallet = new Wallet(privateKey);
        logger.info(`wallet address ${wallet.address}`);
        const chainId = (config.chainId || Chain.POLYGON) as Chain;
        const host = config.clobApiUrl;

<<<<<<< HEAD
        // Create temporary ClobClient (no API key) and derive/create API key
        const clobClient = new ClobClient(host, chainId, wallet);
        const credential = await clobClient.createOrDeriveApiKey();
        await saveCredential(credential);

        logger.info("Credential created successfully");
=======
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
>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
        return credential;
    } catch (error) {
        logger.error("createCredential error", error);
        logger.error(
            `Error creating credential: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
<<<<<<< HEAD
}

export async function saveCredential(credential: ApiKeyCreds): Promise<void> {
    const dir = dirname(CREDENTIAL_PATH);
    mkdirSync(dir, { recursive: true });
    writeFileSync(CREDENTIAL_PATH, JSON.stringify(credential, null, 2));
}

/**
 * Ensure credential file exists: create via createOrDeriveApiKey if missing.
 * Returns true if credentials are available (existing or newly created), false otherwise.
 */
export async function ensureCredential(): Promise<boolean> {
    if (hasCredentialFile()) return true;
    const credential = await createCredential();
    return credential !== null;
=======
}   

export async function saveCredential(credential: ApiKeyCreds) {
    const credentialPath = resolve(process.cwd(), "src/data/credential.json");
    const dir = resolve(process.cwd(), "src/data");
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(credentialPath, JSON.stringify(credential, null, 2));
>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
}