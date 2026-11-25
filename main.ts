// Breadth-velocity bot for the pump.fun replay: a coin qualifies when distinct buyers pile in
// fast (a wide, moving crowd rather than one wallet), and only while its curve is young. It buys
// once the 1% size cap allows, then banks a take-profit, cuts a stop or times out so the slot
// recycles into the next coin.
import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const STAKE = LAMPORTS_PER_SOL / 20n; // 0.05 SOL cap per entry; 0.01 under a shallow curve
const MIN_CAP = LAMPORTS_PER_SOL / 100n; // smallest round trip the guardrail counts
const TAKE_PROFIT = 1.4;
const STOP_LOSS = 0.8;
const MAX_HOLD_SLOTS = 100;
const MAX_SLIPPAGE_BPS = 2_000;

/** [distinct buyers, max slots since creation, min real SOL reserve]. */
const RULES: ReadonlyArray<readonly [number, number, bigint]> = [
  [20, 10, LAMPORTS_PER_SOL],
  [40, 30, LAMPORTS_PER_SOL],
  [80, 60, 5n * LAMPORTS_PER_SOL],
];

interface Track {
  entry_price: number;
  entry_slot: number;
}

const buyers = new Map<string, Set<string>>();
const tracked = new Map<string, Track>();
const candidates = new Set<string>();
const selling = new Set<string>();

function mid(quote: bigint, tokens: bigint): number {
  return Number(quote) / Number(tokens);
}

function qualifies(breadth: number, age: number, real_sol: bigint): boolean {
  for (const [need, max_age, min_reserve] of RULES) {
    if (breadth >= need && age <= max_age && real_sol >= min_reserve) return true;
  }
  return false;
}

await runBot({
  onHello() {},
  onBatch(state, batch) {
    const orders: Array<BuyInput | SellInput> = [];

    // Count the wallets that buy each coin, and keep only the coins still young enough to enter.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        candidates.add(e.mint);
        buyers.set(e.mint, new Set());
      } else if (e.event === 'TradeEvent' && e.is_buy) {
        buyers.get(e.mint)?.add(e.user);
      }
    }

    // A filled buy opens a track at the price the fill landed on.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        const c = state.curves.get(f.mint);
        if (c !== undefined) {
          tracked.set(f.mint, { entry_price: mid(c.virtual_quote_reserves, c.virtual_token_reserves), entry_slot: f.slot });
        }
      }
      if (f.side === 'sell') selling.delete(f.mint);
    }

    // Exits first, so their cash and slots can go back into the next entries.
    for (const [mint, holding] of state.positions) {
      if (selling.has(mint)) continue;
      const c = state.curves.get(mint);
      const t = tracked.get(mint);
      if (c === undefined || c.complete || t === undefined) continue;
      const gain = mid(c.virtual_quote_reserves, c.virtual_token_reserves) / t.entry_price;
      if (gain < TAKE_PROFIT && gain > STOP_LOSS && state.slot - t.entry_slot < MAX_HOLD_SLOTS) continue;
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      selling.add(mint);
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    }

    // Entries: a buy is decided on the first trade event that clears a rule.
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent' || !e.is_buy) continue;
      if (!candidates.has(e.mint)) continue;
      const c = state.curves.get(e.mint);
      if (c === undefined || c.complete || c.created_slot === null) continue;
      const breadth = buyers.get(e.mint)?.size ?? 0;
      const age = state.slot - c.created_slot;
      if (!qualifies(breadth, age, c.real_quote_reserves)) continue;
      candidates.delete(e.mint);
      if (state.positions.has(e.mint)) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_CAP) continue;
      const amount = cap < STAKE ? cap : STAKE;
      if (orders.length >= state.hello.caps.max_orders_per_batch || slots <= 0) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
