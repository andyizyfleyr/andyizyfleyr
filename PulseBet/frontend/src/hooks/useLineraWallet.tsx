import { useState, useCallback, useEffect, createContext, useContext, useRef } from 'react';
import { createLocalClient, getLocalBalance, onBalanceChange, resetLocalBalance, PLAYER_OWNER } from '../lib/localEngine';

/**
 * Demo-mode wallet.
 *
 * PulseBet originally ran on the Linera Conway testnet. That testnet is gone
 * (`testnet-conway.linera.net` no longer resolves), so claiming a chain and
 * settling bets on-chain is impossible. To keep the games playable we run them
 * entirely in the browser: no key, no wallet extension, no network call.
 *
 * The provider still exposes the exact same context shape the games consume
 * (`client`, `chainId`, `owner`, `connect`, ...), so no game hook had to change:
 * `client` is a local implementation that answers the contracts' GraphQL dialect.
 */

const DEMO_CHAIN_ID = 'demo-local-chain';
const LS_BALANCE = 'linera_balance';

interface LineraWalletContextType {
    isReady: boolean;
    isSyncing: boolean;
    isConnected: boolean;
    isConnecting: boolean;
    chainId: string | null;
    owner: string | null;
    /** Kept for backwards compatibility; in demo mode owner === signer. */
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

export const LineraWalletProvider = ({ children }: { children: React.ReactNode }) => {
    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [owner, setOwner] = useState<string | null>(null);
    const [chainId, setChainId] = useState<string | null>(null);
    const [balance, setBalance] = useState<string | null>(getLocalBalance().toFixed(4));
    const [clientInstance, setClientInstance] = useState<any>(null);

    const clientRef = useRef<any>(null);

    // Keep the displayed balance in sync with the local engine.
    useEffect(() => {
        const unsubscribe = onBalanceChange((value) => {
            const formatted = value.toFixed(4);
            setBalance(formatted);
            localStorage.setItem(LS_BALANCE, formatted);
        });
        return () => {
            unsubscribe();
        };
    }, []);

    /** Starts (or restarts) a local session. Instant: nothing is fetched. */
    const connect = useCallback(async () => {
        if (clientRef.current) {
            setIsConnected(true);
            return;
        }
        setIsConnecting(true);
        try {
            const client = createLocalClient(DEMO_CHAIN_ID);
            clientRef.current = client;
            setClientInstance(client);
            setOwner(PLAYER_OWNER);
            setChainId(DEMO_CHAIN_ID);
            setBalance(getLocalBalance().toFixed(4));
            setIsConnected(true);
            console.info('PulseBet demo mode: playing locally, no keys, no network.');
        } finally {
            setIsConnecting(false);
        }
    }, []);

    // Auto-start so games are playable immediately, without a gate.
    useEffect(() => {
        connect();
    }, [connect]);

    const disconnect = useCallback(() => {
        clientRef.current = null;
        setClientInstance(null);
        setIsConnected(false);
        setOwner(null);
        setChainId(null);
        localStorage.removeItem('linera_chain_id');
        localStorage.removeItem('linera_owner');
        localStorage.removeItem('linera_session_key');
    }, []);

    const getApplication = useCallback(
        async (applicationId: string) => {
            if (!clientRef.current) throw new Error('Demo client not ready');
            return clientRef.current.application(applicationId);
        },
        []
    );

    /** Demo faucet: tops the local balance back up instead of claiming a chain. */
    const requestFaucet = useCallback(async () => {
        resetLocalBalance();
        setBalance(getLocalBalance().toFixed(4));
    }, []);

    return (
        <LineraWalletContext.Provider
            value={{
                isReady: true,
                isSyncing: false,
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
                error: null,
            }}
        >
            {children}
        </LineraWalletContext.Provider>
    );
};

export const useLineraWallet = () => {
    const context = useContext(LineraWalletContext);
    if (!context) {
        throw new Error('useLineraWallet must be used within a LineraWalletProvider');
    }
    return context;
};
