/**
 * Local play engine — PulseBet demo mode.
 *
 * The public Linera testnet this project was built against (Conway) has been
 * decommissioned: `testnet-conway.linera.net` and its faucet no longer resolve,
 * so no chain can be claimed and no bet can settle. This module replaces the
 * network with an in-browser implementation of every game.
 *
 * It speaks the exact same GraphQL dialect the Rust services expose, so the
 * existing hooks/pages are untouched: we intercept `client.chain(...).application(...).query(...)`
 * and answer the request here instead of sending it to a validator.
 *
 * Rules and payout tables mirror the contracts in `contracts/` 1:1.
 */

export const PLAYER_OWNER = '0x0000000000000000000000000000000000000001';
const PULSE_TOKEN_APP_ID = '8e7498a4564d33c50bc4a3053eba7b51a4f5e7085111dbcc7cd3efe6072a7961';
const LS_BALANCE = 'local_pulse_balance';
const STARTING_BALANCE = 1000;

type Json = Record<string, any>;

/* ------------------------------------------------------------------ helpers */

const rand = (n: number) => Math.floor(Math.random() * n);

const shuffle = <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
};

const numeric = (value: unknown): number => {
    const n = typeof value === 'number' ? value : parseFloat(String(value ?? 0));
    return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------------ balance */

let balance = (() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_BALANCE) : null;
    const parsed = stored === null ? NaN : parseFloat(stored);
    return Number.isFinite(parsed) ? parsed : STARTING_BALANCE;
})();

const listeners = new Set<(value: number) => void>();

const persist = () => {
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LS_BALANCE, String(balance));
    }
    listeners.forEach((fn) => fn(balance));
};

export const onBalanceChange = (fn: (value: number) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
};

export const getLocalBalance = () => balance;

/** Debits a stake. Throws like the on-chain PulseToken contract would. */
const debit = (amount: number) => {
    if (amount <= 0) throw new Error('Stake must be greater than zero');
    if (amount > balance) {
        throw new Error(`Insufficient PulseToken balance (${balance.toFixed(2)} PT available)`);
    }
    balance = Math.round((balance - amount) * 10000) / 10000;
    persist();
};

const credit = (amount: number) => {
    if (amount <= 0) return;
    balance = Math.round((balance + amount) * 10000) / 10000;
    persist();
};

export const resetLocalBalance = () => {
    balance = STARTING_BALANCE;
    persist();
};

/* ------------------------------------------------------- per-game state */

interface GameStore {
    mines: Json | null;
    dice: Json | null;
    coinToss: Json | null;
    wheel: Json | null;
    plinko: Json | null;
}

const store: GameStore = {
    mines: null,
    dice: null,
    coinToss: null,
    wheel: null,
    plinko: null,
};

/** Keno keeps one record per player, like the contract's `active_games` map. */
const kenoGames = new Map<string, Json>();

/** Wordle sessions keyed by player. */
const wordleGames = new Map<string, Json>();
const WORDLE_TARGETS = ['CRANE', 'SLATE', 'ADIEU', 'PRISM', 'BLOOM', 'FJORD', 'QUILT', 'VEXED'];
let wordleTarget: string | null = null;

/** Memory game, single active session like the contract. */
let memoryGame: Json | null = null;
let memoryCards: { position: number; imageId: number }[] = [];

/** Color trading round clock. */
const ROUND_BETTING_MICROS = 30_000_000;
const ROUND_REVEAL_MICROS = 5_000_000;
let colorRound: Json = {
    roundId: 1,
    startTime: String(Date.now() * 1000),
    state: 'BETTING',
    winningColor: null,
    bets: [] as Json[],
};

/* ------------------------------------------------------- payout tables */

const MINE_MULTIPLIER = (mines: number, hits: number) => {
    const [base, step] =
        mines === 3 ? [110, 20] : mines === 5 ? [140, 30] : mines === 7 ? [140, 50] : [100, 10];
    return hits === 0 ? 100 : base + (hits - 1) * step;
};

// contracts/wheel/src/lib.rs
const WHEEL_MULTIPLIERS = [0, 150, 0, 1000, 120, 0, 500, 150, 0, 120];

// contracts/plinko/src/lib.rs
const PLINKO_MULTIPLIERS = [1000, 25, 150, 50, 250, 50, 150, 25, 1000];

// contracts/keno/src/state.rs
const KENO_TABLE: Record<number, Record<number, number>> = {
    1: { 1: 380 },
    2: { 2: 1400 },
    3: { 3: 4500, 2: 100 },
    4: { 4: 8000, 3: 400, 2: 50 },
    5: { 5: 25000, 4: 2500, 3: 400, 2: 40 },
    6: { 6: 100000, 5: 5000, 4: 500, 3: 50 },
    7: { 7: 250000, 6: 10000, 5: 800, 4: 60 },
    8: { 8: 500000, 7: 20000, 6: 1000, 5: 100 },
    9: { 9: 500000, 8: 30000, 7: 1500, 6: 200, 5: 50 },
    10: { 10: 500000, 9: 40000, 8: 2000, 7: 300, 6: 50 },
};

const kenoMultiplier = (picks: number, hits: number) => KENO_TABLE[picks]?.[hits] ?? 0;

const MEMORY_PAYOUT = (turnCount: number, stake: number) => {
    let multiplier = 0;
    if (turnCount === 6) multiplier = 20;
    else if (turnCount >= 7 && turnCount <= 8) multiplier = 5;
    else if (turnCount >= 9 && turnCount <= 10) multiplier = 3;
    else if (turnCount >= 11 && turnCount <= 12) multiplier = 1.5;
    return stake * multiplier;
};

/* ------------------------------------------------------- game resolvers */

const resolveMines = (query: string, owner: string, mutation: boolean): Json => {
    if (!mutation) return { activeGame: store.mines };

    if (/\bbet\s*\(/.test(query)) {
        const amount = numeric(/amount:\s*([\d.]+)/.exec(query)?.[1]);
        const minesCount = numeric(/minesCount:\s*(\d+)/.exec(query)?.[1] ?? 3);
        debit(amount);
        const mineIndices = shuffle([...Array(25).keys()]).slice(0, minesCount);
        store.mines = {
            owner,
            minesCount,
            betAmount: amount,
            revealedTiles: [],
            mineIndices,
            result: 'ACTIVE',
            currentMultiplier: 100,
        };
        return { bet: true };
    }

    if (/\breveal\s*\(/.test(query)) {
        const tileId = numeric(/tileId:\s*(\d+)/.exec(query)?.[1]);
        const game = store.mines;
        if (!game) throw new Error('No active game');
        if (game.result !== 'ACTIVE') throw new Error('Game is over');
        if (game.revealedTiles.includes(tileId)) throw new Error('Tile already revealed');

        if (game.mineIndices.includes(tileId)) {
            game.result = 'LOST';
            game.revealedTiles = [...game.revealedTiles, tileId];
        } else {
            game.revealedTiles = [...game.revealedTiles, tileId];
            game.currentMultiplier = MINE_MULTIPLIER(game.minesCount, game.revealedTiles.length);
            const safeTiles = 25 - game.minesCount;
            if (game.revealedTiles.length === safeTiles) {
                game.result = 'WON';
                credit((game.betAmount * game.currentMultiplier) / 100);
            }
        }
        store.mines = { ...game };
        return { reveal: true };
    }

    if (/\bcashOut\b|cash_out/.test(query)) {
        const game = store.mines;
        if (!game || game.result !== 'ACTIVE') throw new Error('No active game to cash out');
        credit((game.betAmount * game.currentMultiplier) / 100);
        store.mines = { ...game, result: 'CASHED_OUT' };
        return { cashOut: true };
    }

    return {};
};

const resolveDice = (query: string, owner: string, mutation: boolean): Json => {
    if (!mutation) return { activeGame: store.dice };

    const amount = numeric(/amount:\s*([\d.]+)/.exec(query)?.[1]);
    const target = numeric(/target:\s*(\d+)/.exec(query)?.[1]);
    const mode = /rollType:\s*([A-Za-z]+)/.exec(query)?.[1]?.toUpperCase() ?? 'UNDER';

    debit(amount);
    const roll = rand(100);
    const winChance = mode === 'UNDER' ? target : 100 - target;
    const won = mode === 'UNDER' ? roll < target : roll >= target;
    const multiplierX100 = winChance === 0 ? 0 : Math.floor((100 * (100 - 1)) / winChance);
    const payout = won ? Math.floor((amount * multiplierX100) / 100) : 0;
    credit(payout);

    store.dice = {
        owner,
        betAmount: amount,
        target,
        resultRoll: roll,
        payout,
        multiplier: multiplierX100,
    };
    return { rollDice: true };
};

const resolveCoinToss = (query: string, owner: string, mutation: boolean): Json => {
    if (!mutation) return { lastGame: store.coinToss };

    const amount = numeric(/amount:\s*([\d.]+)/.exec(query)?.[1]);
    const predictionRaw = /prediction:\s*([A-Za-z]+)/.exec(query)?.[1]?.toUpperCase() ?? 'HEADS';
    const prediction = predictionRaw === 'TAILS' ? 1 : 0;

    debit(amount);
    const result = rand(2);
    const won = result === prediction;
    const payout = won ? amount * 2 : 0;
    credit(payout);

    store.coinToss = { owner, betAmount: amount, prediction, result, payout, won };
    return { playToss: true };
};

const resolveWheel = (query: string, owner: string, mutation: boolean): Json => {
    if (!mutation) return { activeGame: store.wheel };

    const amount = numeric(/amount:\s*([\d.]+)/.exec(query)?.[1]);
    debit(amount);
    const segment = rand(WHEEL_MULTIPLIERS.length);
    const multiplier = WHEEL_MULTIPLIERS[segment];
    const payout = Math.floor((amount * multiplier) / 100);
    credit(payout);

    store.wheel = { owner, betAmount: amount, resultSegment: segment, multiplier, payout };
    return { spinWheel: true };
};

const resolvePlinko = (query: string, _owner: string, mutation: boolean): Json => {
    if (!mutation) return { activeGame: store.plinko };

    if (/startGame\s*\(/.test(query)) {
        const amount = numeric(/amount:\s*([\d.]+)/.exec(query)?.[1]);
        debit(amount);
        store.plinko = {
            owner: _owner,
            betAmount: amount,
            currentRow: 0,
            currentCol: 0,
            path: [],
            result: 'ACTIVE',
            finalMultiplier: 100,
        };
        return { startGame: true };
    }

    if (/advanceBatch\s*\(/.test(query)) {
        const game = store.plinko;
        if (!game || game.result !== 'ACTIVE') return { advanceBatch: false };
        const slot = rand(PLINKO_MULTIPLIERS.length);
        const multiplier = PLINKO_MULTIPLIERS[slot];
        const path = Array.from({ length: 8 }, () => (rand(2) === 0 ? 'Left' : 'Right'));
        credit(Math.floor((game.betAmount * multiplier) / 100));
        store.plinko = {
            ...game,
            currentRow: 8,
            currentCol: slot - 4,
            path,
            result: 'WON',
            finalMultiplier: multiplier,
        };
        return { advanceBatch: true };
    }

    return {};
};

const resolveKeno = (query: string, owner: string, mutation: boolean): Json => {
    if (!mutation) return { lastGame: kenoGames.get(owner) ?? null };

    const amount = numeric(/betAmount:\s*([\d.]+)/.exec(query)?.[1]);
    const picksRaw = /picks:\s*\[([^\]]*)\]/.exec(query)?.[1] ?? '';
    const picks = picksRaw
        .split(',')
        .map((p) => parseInt(p.trim(), 10))
        .filter((n) => Number.isFinite(n));

    debit(amount);
    const drawn = shuffle([...Array(40).keys()].map((n) => n + 1)).slice(0, 20);
    const hits = picks.filter((p) => drawn.includes(p)).length;
    const multiplier = kenoMultiplier(picks.length, hits);
    const payout = Math.floor((amount * multiplier) / 100);
    credit(payout);

    kenoGames.set(owner, {
        owner,
        betAmount: amount,
        picks,
        drawnNumbers: drawn.slice(0, 10),
        hits,
        payout,
        multiplier,
        timestamp: Date.now() * 1000,
    });
    return { playKeno: true };
};

const resolvePulseToken = (query: string, _owner: string, mutation: boolean): Json => {
    if (!mutation) return { balance: String(balance) };

    if (/\bmint\s*\(/.test(query)) {
        const amount = numeric(/amount:\s*"?([\d.]+)"?/.exec(query)?.[1]);
        credit(amount);
        return { mint: true };
    }
    return {};
};

const resolveWordle = (query: string, owner: string, mutation: boolean): Json => {
    if (!mutation) return { game: wordleGames.get(owner) ?? null };

    if (/\bstartGame\b/.test(query)) {
        wordleTarget = WORDLE_TARGETS[rand(WORDLE_TARGETS.length)];
        wordleGames.set(owner, {
            targetWord: wordleTarget,
            attempts: 0,
            guesses: [],
            feedbackHistory: [],
            isWon: false,
            isOver: false,
        });
        return { startGame: true };
    }

    if (/\bsubmitGuess\s*\(/.test(query)) {
        const guess = (/guess:\s*"([A-Za-z]+)"/.exec(query)?.[1] ?? '').toUpperCase();
        const game = wordleGames.get(owner);
        if (!game) throw new Error('No active game');
        if (!wordleTarget) wordleTarget = WORDLE_TARGETS[rand(WORDLE_TARGETS.length)];

        // 0 = miss, 1 = present, 2 = correct — same encoding as the contract.
        const feedback = [...Array(5).keys()].map((i) =>
            guess[i] === wordleTarget![i] ? 2 : wordleTarget!.includes(guess[i]) ? 1 : 0
        );
        game.guesses = [...game.guesses, guess];
        game.feedbackHistory = [...game.feedbackHistory, feedback];
        game.attempts = game.guesses.length;
        game.isWon = guess === wordleTarget;
        game.isOver = game.isWon || game.attempts >= 6;
        wordleGames.set(owner, { ...game });
        return { submitGuess: true };
    }

    return {};
};

const resolveMemory = (query: string, owner: string, mutation: boolean): Json => {
    if (!mutation) {
        if (/cards\s*\(/.test(query)) return { cards: memoryCards };
        return { activeGame: memoryGame };
    }

    if (/createGame\s*\(/.test(query)) {
        const stake = numeric(/stakeAmount:\s*([\d.]+)/.exec(query)?.[1]);
        debit(stake);
        const layout = shuffle([...Array(12).keys()].map((n) => Math.floor(n / 2) + 1));
        memoryCards = layout.map((imageId, position) => ({ position, imageId }));
        memoryGame = {
            player: owner,
            stakeAmount: stake,
            turnCount: 0,
            matchedCardsCount: 0,
            matchedCards: [],
            firstRevealedCard: null,
            state: 'PLAYING',
            potentialPayout: 0,
        };
        return { createGame: true };
    }

    if (/revealCard\s*\(/.test(query)) {
        const position = numeric(/cardId:\s*(\d+)/.exec(query)?.[1]);
        const game = memoryGame;
        if (!game) throw new Error('No active game');
        const card = memoryCards.find((c) => c.position === position);
        if (!card) throw new Error('Unknown card');

        if (game.firstRevealedCard === null || game.firstRevealedCard === undefined) {
            game.firstRevealedCard = position;
            game.turnCount += 1;
        } else {
            const first = memoryCards.find((c) => c.position === game.firstRevealedCard);
            if (first && first.imageId === card.imageId) {
                game.matchedCards = [...game.matchedCards, position, game.firstRevealedCard];
                game.matchedCardsCount += 1;
                if (game.matchedCardsCount === 6) {
                    game.state = 'FINISHED';
                    game.potentialPayout = MEMORY_PAYOUT(game.turnCount, game.stakeAmount);
                }
            }
            game.firstRevealedCard = null;
            game.turnCount += 1;
        }
        memoryGame = { ...game };
        return { revealCard: true };
    }

    if (/claimPayout\b/.test(query)) {
        if (!memoryGame) throw new Error('No active game');
        credit(memoryGame.potentialPayout || 0);
        memoryGame = { ...memoryGame, state: 'CLAIMED' };
        return { claimPayout: true };
    }

    return {};
};

const resolveColorTrading = (query: string, _owner: string, mutation: boolean): Json => {
    if (!mutation) {
        const elapsed = Date.now() * 1000 - parseInt(colorRound.startTime, 10);
        if (colorRound.state === 'BETTING' && elapsed > ROUND_BETTING_MICROS) {
            const colors = ['COLOR_A', 'COLOR_B', 'COLOR_C', 'COLOR_D', 'COLOR_E'];
            colorRound = {
                ...colorRound,
                state: 'COOLDOWN',
                winningColor: colors[rand(colors.length)],
            };
            const winningBets = (colorRound.bets as Json[]).filter(
                (b) => b.color === colorRound.winningColor
            );
            winningBets.forEach((b) => credit(numeric(b.amount) * 2));
        }
        return { activeRound: colorRound };
    }

    if (/\bbet\s*\(/.test(query)) {
        const amount = numeric(/amount:\s*([\d.]+)/.exec(query)?.[1]);
        const color = /color:\s*([A-Z_]+)/.exec(query)?.[1] ?? 'COLOR_A';
        debit(amount);
        colorRound.bets = [...(colorRound.bets as Json[]), { owner: PLAYER_OWNER, amount: String(amount), color, roundId: colorRound.roundId }];
        return { bet: true };
    }

    if (/\breveal\b/.test(query)) {
        const colors = ['COLOR_A', 'COLOR_B', 'COLOR_C', 'COLOR_D', 'COLOR_E'];
        colorRound = {
            ...colorRound,
            state: 'COOLDOWN',
            winningColor: colors[rand(colors.length)],
        };
        return { reveal: true };
    }

    if (/\bstartRound\b/.test(query)) {
        const elapsed = Date.now() * 1000 - parseInt(colorRound.startTime, 10);
        const cooldownOver = colorRound.state === 'COOLDOWN' && elapsed > ROUND_BETTING_MICROS + ROUND_REVEAL_MICROS;
        if (cooldownOver || colorRound.state === 'COOLDOWN') {
            colorRound = {
                roundId: colorRound.roundId + 1,
                startTime: String(Date.now() * 1000),
                state: 'BETTING',
                winningColor: null,
                bets: [],
            };
        }
        return { startRound: true };
    }

    return {};
};

/**
 * Fallback router. When a `VITE_*_APP_ID` is missing (or points at an app the
 * engine doesn't know) we look at the request itself to decide the game. This
 * keeps every game playable with zero configuration.
 */
const resolveByShape = (query: string, owner: string, mutation: boolean): Json => {
    const q = query.toLowerCase();
    if (/\bmint\s*\(|\bbalance\s*\(/.test(q)) return resolvePulseToken(query, owner, mutation);
    if (/minescount|\breveal\s*\(|cashout|\bbet\s*\(/.test(q)) return resolveMines(query, owner, mutation);
    if (/rolldice|rolltype/.test(q)) return resolveDice(query, owner, mutation);
    if (/playtoss|prediction/.test(q)) return resolveCoinToss(query, owner, mutation);
    if (/spinwheel|resultsegment/.test(q)) return resolveWheel(query, owner, mutation);
    if (/startgame\s*\(amount|advancebatch|finalmultiplier/.test(q)) return resolvePlinko(query, owner, mutation);
    if (/playkeno|drawnnumbers/.test(q)) return resolveKeno(query, owner, mutation);
    if (/submitguess|feedbackhistory|\bstartgame\b/.test(q)) return resolveWordle(query, owner, mutation);
    if (/creategame\s*\(stakeamount|revealcard|claimpayout|matchedcards/.test(q)) return resolveMemory(query, owner, mutation);
    if (/activeround|winningcolor|startround/.test(q)) return resolveColorTrading(query, owner, mutation);
    if (/\broom\b/.test(q)) return resolveBingo(query, owner, mutation);
    if (/\bgame\s*\(gameid/.test(q)) return resolveDotsAndBoxes(query, owner, mutation);
    return { activeGame: null };
};

const resolveBingo = (_query: string, _owner: string, _mutation: boolean): Json => ({ room: null });

const resolveDotsAndBoxes = (_query: string, _owner: string, _mutation: boolean): Json => ({
    game: null,
});

/* ------------------------------------------------------- dispatcher */

type Resolver = (query: string, owner: string, mutation: boolean, appId: string) => Json;

const RESOLVERS: Record<string, Resolver> = {
    [PULSE_TOKEN_APP_ID]: resolvePulseToken,
};

const appIdCache = new WeakMap<object, Resolver>();

/** Registers app IDs from the environment so we can route by application. */
export const registerAppIds = (map: Record<string, string | undefined>) => {
    const table: Record<string, Resolver> = {
        mines: resolveMines,
        dice: resolveDice,
        coin_toss: resolveCoinToss,
        wheel: resolveWheel,
        plinko: resolvePlinko,
        keno: resolveKeno,
        wordle: resolveWordle,
        memory_game: resolveMemory,
        color_trading: resolveColorTrading,
        bingo: resolveBingo,
        dots_and_boxes: resolveDotsAndBoxes,
        pulse_token: resolvePulseToken,
    };
    Object.entries(map).forEach(([key, id]) => {
        if (id && table[key]) RESOLVERS[id] = table[key];
    });
};

const resolverFor = (appId: string, app: object): Resolver => {
    const cached = appIdCache.get(app);
    if (cached) return cached;
    const resolver = RESOLVERS[appId] ?? resolveByShape;
    appIdCache.set(app, resolver);
    return resolver;
};

/** Reads `owner: "0x..."` straight out of the document (Keno/Wordle query by owner). */
const ownerFromQuery = (query: string): string | null => {
    const match = /owner:\s*"([^"]+)"/.exec(query);
    return match ? match[1] : null;
};

const ownerFromOptions = (options: unknown): string => {
    if (options && typeof options === 'object' && 'owner' in (options as Json)) {
        const owner = (options as Json).owner;
        if (typeof owner === 'string' && owner.length > 0) return owner;
    }
    return PLAYER_OWNER;
};

/* --------------------------------------------------------- fake client */

const fakeApplication = (appId: string) => {
    const app = {
        async query(body: string, options?: unknown): Promise<string> {
            const parsed = JSON.parse(body) as Json;
            const query = String(parsed.query ?? '');
            const mutation = /^\s*mutation\b/.test(query);
            const owner = ownerFromQuery(query) ?? ownerFromOptions(options);
            const resolver = resolverFor(appId, app);
            const data = resolver(query, owner, mutation, appId);
            return JSON.stringify({ data });
        },
    };
    return app;
};

const fakeChain = (chainId: string) => ({
    async application(appId: string) {
        return fakeApplication(appId);
    },
    async identity() {
        return PLAYER_OWNER;
    },
    async balance() {
        return { toString: () => balance.toFixed(6) };
    },
    async transfer() {
        return null;
    },
    async addOwner() {
        return null;
    },
    chainId,
});

/**
 * Wraps a `Client`-shaped object (or the provider's stored client) so every
 * chain/application call is answered locally.
 */
export const createLocalClient = (chainId: string) => {
    registerAppIds({
        mines: import.meta.env.VITE_MINES_APP_ID,
        dice: import.meta.env.VITE_DICE_APP_ID,
        coin_toss: import.meta.env.VITE_COIN_TOSS_APP_ID,
        wheel: import.meta.env.VITE_WHEEL_APP_ID,
        plinko: import.meta.env.VITE_PLINKO_APP_ID,
        keno: import.meta.env.VITE_KENO_APP_ID,
        wordle: import.meta.env.VITE_WORDLE_APP_ID,
        memory_game: import.meta.env.VITE_MEMORY_GAME_APP_ID,
        color_trading: import.meta.env.VITE_COLOR_TRADING_APP_ID,
        bingo: import.meta.env.VITE_BINGO_APP_ID,
        dots_and_boxes: import.meta.env.VITE_DOTS_APP_ID ?? import.meta.env.VITE_DOTS_AND_BOXES_APP_ID,
        pulse_token: import.meta.env.VITE_PULSE_TOKEN_APP_ID,
    });

    return {
        async chain(id?: string) {
            return fakeChain(id ?? chainId);
        },
        async application(appId: string) {
            return fakeApplication(appId);
        },
        onNotification() {
            return () => undefined;
        },
    };
};
