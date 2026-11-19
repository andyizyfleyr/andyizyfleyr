import { useState, useCallback, useEffect, createContext, useContext, useRef } from 'react';
import { initialize, Client, Faucet } from "@linera/client";
import * as linera from "@linera/client";

/**
 * Wallet without any browser extension.
 *
 * A local session key (secp256k1 / EIP-191, generated in the browser) is used as
 * the chain owner AND as the signer. Having a single owner means every mutation
 * (bet, reveal, cash out, mint, ...) is signed by the same key the chain knows
 * about, which is what makes the games actually settle on chain.
 *
 * The key is persisted in localStorage so the session survives reloads.
 */

const LS_CHAIN_ID = "linera_chain_id";
const LS_OWNER = "linera_owner";
const LS_SESSION_KEY = "linera_session_key";
const LS_BALANCE = "linera_balance";

const DEFAULT_NODE_URL = "https://testnet-conway.linera.net";

interface LineraWalletContextType {
    isReady: boolean;
    isSyncing: boolean;
    isConnected: boolean;
    isConnecting: boolean;
    chainId: string | null;
    owner: string | null;
    /** Kept for backwards compatibility: with a single session key, owner === signer. */
    autosignerOwner: string | null;
    balance: string | null;
    client: any | null;
    getApplication: (applicationId: string) => Promise<any>;
    connect: () => Promise<void>;
    disconnect: () => void;
    requestFaucet: () => Promise<void>;
    error: string | null;
}

const LineraWalletContext = createContext<LineraWalletContextType | undefined>(undefined);

// `initialize()` loads the Linera wasm module; it must only run once per page.
let wasmReady: Promise<unknown> | null = null;
const ensureWasm = () => {
    if (!wasmReady) {
        wasmReady = initialize().catch((e) => {
            wasmReady = null; // allow a retry after a transient failure
            throw e;
        });
    }
    return wasmReady;
};

const DIRECT_FAUCET_URL = "https://faucet.testnet-conway.linera.net";

/**
 * Faucet endpoints, most specific first.
 *
 * The same-origin `/faucet-proxy` is normally used (CORS + Vercel rewrite), but it
 * only works when the *server* running the dev/preview proxy can reach the testnet.
 * If that proxy is unreachable we fall back to calling the public faucet directly
 * from the browser, which is what makes the button work in restricted environments
 * instead of failing silently.
 */
const faucetUrls = (): string[] => {
    const configured = import.meta.env.VITE_LINERA_FAUCET_URL?.trim();
    const list: string[] = [];
    if (configured) list.push(configured);
    if (typeof window !== "undefined") list.push(window.location.origin + "/faucet-proxy");
    list.push(DIRECT_FAUCET_URL);
    return [...new Set(list)];
};

/** Claims a chain, transparently retrying on the next faucet endpoint. */
const claimChainWithFallback = async (owner: string) => {
    let lastError: unknown = null;
    for (const url of faucetUrls()) {
        try {
            const faucet = new Faucet(url);
            const wallet = await faucet.createWallet();
            const chain = await faucet.claimChain(wallet, owner);
            console.info("Faucet used:", url);
            return { chain, wallet, faucetUrl: url };
        } catch (e) {
            console.warn(`Faucet ${url} failed, trying next endpoint...`, e);
            lastError = e;
        }
    }
    throw lastError ?? new Error("No faucet endpoint reachable");
};

/** Just the wallet (genesis/config), without claiming a chain. */
const createWalletWithFallback = async () => {
    let lastError: unknown = null;
    for (const url of faucetUrls()) {
        try {
            const wallet = await new Faucet(url).createWallet();
            return wallet;
        } catch (e) {
            console.warn(`Wallet from ${url} failed, trying next endpoint...`, e);
            lastError = e;
        }
    }
    throw lastError ?? new Error("No faucet endpoint reachable");
};

const configuredNodeUrl = () =>
    import.meta.env.VITE_LINERA_NODE_URL?.trim() ||
    import.meta.env.VITE_LINERA_TARGET_URL?.trim() ||
    DEFAULT_NODE_URL;

/**
 * The wasm client talks GraphQL to a validator. `/node-proxy` is the default, but it
 * lives on the machine serving the app: if that machine cannot reach the Linera
 * testnet (sandboxed preview, offline dev box) every block query fails and the games
 * look dead. We therefore probe the candidates and keep the first one that answers.
 */
const nodeCandidates = (): string[] => {
    const list: string[] = [];
    const configured = configuredNodeUrl();
    if (configured.startsWith("/") && typeof window !== "undefined") {
        list.push(window.location.origin + configured);
    } else if (configured) {
        list.push(configured);
    }
    if (typeof window !== "undefined") list.push(window.location.origin + "/node-proxy");
    list.push(DEFAULT_NODE_URL);
    return [...new Set(list)];
};

let resolvedNodeUrl: string | null = null;
const resolveNodeUrl = async (): Promise<string> => {
    if (resolvedNodeUrl) return resolvedNodeUrl;

    for (const candidate of nodeCandidates()) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(candidate, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: "{ chains { list } }" }),
                signal: controller.signal,
            });
            if (res.ok || res.status === 400) {
                // 400 still proves the GraphQL endpoint is reachable.
                console.info("Linera node in use:", candidate);
                resolvedNodeUrl = candidate;
                return candidate;
            }
        } catch (e) {
            console.warn(`Node ${candidate} unreachable, trying next...`, e);
        } finally {
            clearTimeout(timer);
        }
    }

    console.warn("No Linera node answered, falling back to", DEFAULT_NODE_URL);
    resolvedNodeUrl = DEFAULT_NODE_URL;
    return resolvedNodeUrl;
};

/** Extracts the raw private key out of a Linera PrivateKey signer (runtime field). */
const secretOf = (signer: any): string | null => {
    const candidates = [signer?.wallet?.privateKey, signer?.secret, signer?.privateKey];
    return candidates.find((v) => typeof v === "string" && v.length > 0) ?? null;
};

export const LineraWalletProvider = ({ children }: { children: React.ReactNode }) => {
    const [isReady, setIsReady] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [owner, setOwner] = useState<string | null>(null);
    const [chainId, setChainId] = useState<string | null>(null);
    const [balance, setBalance] = useState<string | null>(localStorage.getItem(LS_BALANCE));
    const [error, setError] = useState<string | null>(null);
    const [clientInstance, setClientInstance] = useState<any>(null);

    const clientRef = useRef<any>(null);
    const signerRef = useRef<any>(null);
    const restoringRef = useRef(false);

    const fetchBalance = useCallback(async () => {
        if (!chainId || !clientRef.current) return;
        try {
            const chain = await clientRef.current.chain(chainId);
            const bal = await chain.balance();
            const balStr = bal?.toString() || "0";
            setBalance(balStr);
            localStorage.setItem(LS_BALANCE, balStr);
        } catch (e) {
            console.warn("Balance fetch failed:", e);
        }
    }, [chainId]);

    useEffect(() => {
        if (isConnected && chainId) {
            fetchBalance();
            const interval = setInterval(fetchBalance, 5000);
            return () => clearInterval(interval);
        }
    }, [isConnected, chainId, fetchBalance]);

    /** Builds (or rebuilds) the client for an existing session key. */
    const bootClient = useCallback(async (signer: any, chain: string, walletOverride?: any) => {
        const wallet = walletOverride ?? (await createWalletWithFallback());
        wallet.setOwner(chain, signer.address());

        const validators = [await resolveNodeUrl()];
        const client = await new Client(wallet, signer, { validators } as any);
        const chainHandle = await client.chain(chain);
        const bal = await chainHandle.balance();

        clientRef.current = client;
        signerRef.current = signer;
        setClientInstance(client);
        setOwner(signer.address());
        setChainId(chain);
        setBalance(bal?.toString() || "0");
        localStorage.setItem(LS_BALANCE, bal?.toString() || "0");
        setIsConnected(true);
        return client;
    }, []);

    /** Restores a previous session from localStorage, if any. */
    useEffect(() => {
        if (restoringRef.current) return;
        restoringRef.current = true;

        const restore = async () => {
            const storedKey = localStorage.getItem(LS_SESSION_KEY);
            const storedChain = localStorage.getItem(LS_CHAIN_ID);
            if (!storedKey || !storedChain) {
                return;
            }

            if (!window.crossOriginIsolated) {
                setError("Missing server headers (COOP/COEP). Restart the dev server.");
                return;
            }

            try {
                setIsSyncing(true);
                await ensureWasm();
                setIsReady(true);

                const signer = new linera.signer.PrivateKey(storedKey);
                setOwner(signer.address());
                await bootClient(signer, storedChain);
                console.info("Session restored:", signer.address());
            } catch (e: any) {
                console.warn("Session restore failed, clearing it:", e);
                [LS_SESSION_KEY, LS_CHAIN_ID, LS_OWNER, LS_BALANCE].forEach((k) =>
                    localStorage.removeItem(k)
                );
                clientRef.current = null;
                signerRef.current = null;
                setClientInstance(null);
                setIsConnected(false);
                setOwner(null);
                setChainId(null);
            } finally {
                setIsSyncing(false);
            }
        };

        restore();
    }, [bootClient]);

    const connect = async () => {
        if (isConnecting) return;
        setIsConnecting(true);
        setError(null);

        try {
            if (!window.crossOriginIsolated) {
                throw new Error(
                    "Linera needs Cross-Origin Isolation (COOP/COEP headers) to run its wasm worker."
                );
            }

            await ensureWasm();
            setIsReady(true);
            setIsSyncing(true);

            // 1. Fresh local session key — no browser extension involved.
            const signer = linera.signer.PrivateKey.createRandom();
            const sessionOwner = signer.address();

            // 2. Claim a microchain owned by that key (with endpoint fallback).
            const { chain, wallet: claimedWallet } = await claimChainWithFallback(sessionOwner);
            const wallet = claimedWallet;
            wallet.setOwner(chain, sessionOwner);

            // 3. Persist before connecting, so a reload can resume the session.
            const secret = secretOf(signer);
            if (secret) localStorage.setItem(LS_SESSION_KEY, secret);
            localStorage.setItem(LS_OWNER, sessionOwner);
            localStorage.setItem(LS_CHAIN_ID, chain);

            // 4. Single signer for both background reads and mutations.
            const validators = [await resolveNodeUrl()];
            const client = await new Client(wallet, signer, { validators } as any);
            const chainHandle = await client.chain(chain);
            const bal = await chainHandle.balance();

            clientRef.current = client;
            signerRef.current = signer;
            setClientInstance(client);
            setOwner(sessionOwner);
            setChainId(chain);
            setBalance(bal?.toString() || "0");
            localStorage.setItem(LS_BALANCE, bal?.toString() || "0");
            setIsConnected(true);
            console.info("Session ready:", { owner: sessionOwner, chain });
        } catch (e: any) {
            console.error("Session creation failed:", e);
            [LS_SESSION_KEY, LS_CHAIN_ID, LS_OWNER].forEach((k) => localStorage.removeItem(k));
            setError(e?.message || "Could not start a session");
        } finally {
            setIsSyncing(false);
            setIsConnecting(false);
        }
    };

    const disconnect = useCallback(async () => {
        [LS_CHAIN_ID, LS_OWNER, LS_SESSION_KEY, LS_BALANCE].forEach((k) =>
            localStorage.removeItem(k)
        );

        clientRef.current = null;
        signerRef.current = null;

        const dbsToDelete = ["linera", "linera_testnet", "linera_db", "linera-wasm"];
        try {
            if (window.indexedDB?.databases) {
                const dbs = await window.indexedDB.databases();
                dbs.forEach((db) => db.name && dbsToDelete.push(db.name));
            }
        } catch (e) {
            console.warn("Could not list databases", e);
        }

        await Promise.all(
            [...new Set(dbsToDelete)].map(
                (name) =>
                    new Promise<void>((resolve) => {
                        const req = window.indexedDB.deleteDatabase(name);
                        req.onsuccess = () => resolve();
                        req.onerror = () => resolve();
                        req.onblocked = () => resolve();
                    })
            )
        );

        setTimeout(() => window.location.reload(), 300);
    }, []);

    const getApplication = useCallback(
        async (applicationId: string) => {
            if (!chainId) throw new Error("Client not ready or chain ID missing");
            if (!clientRef.current) throw new Error("Client not ready");
            const chain = await clientRef.current.chain(chainId);
            return await chain.application(applicationId);
        },
        [chainId]
    );

    const requestFaucet = useCallback(async () => {
        if (!owner) return;
        try {
            const { chain } = await claimChainWithFallback(owner);
            localStorage.setItem(LS_CHAIN_ID, chain);
            await fetchBalance();
        } catch (e: any) {
            console.error(e);
            setError(e?.message || "Failed to request faucet funds");
        }
    }, [owner, fetchBalance]);

    return (
        <LineraWalletContext.Provider
            value={{
                isReady,
                isSyncing,
                isConnected,
                isConnecting,
                chainId,
                owner,
                autosignerOwner: owner,
                balance,
                client: clientInstance,
                getApplication,
                connect,
                disconnect,
                requestFaucet,
                error,
            }}
        >
            {children}
        </LineraWalletContext.Provider>
    );
};

export const useLineraWallet = () => {
    const context = useContext(LineraWalletContext);
    if (!context) {
        throw new Error("useLineraWallet must be used within a LineraWalletProvider");
    }
    return context;
};
