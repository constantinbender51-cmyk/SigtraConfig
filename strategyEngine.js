// strategyEngine.js — v2 with regime filters & micro-structure refinement
import fs from 'fs';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { log } from './logger.js';

const BOT_START_TIME = new Date().toISOString();

/* ---------- unchanged helpers ---------- */
const readLast10ClosedTradesFromFile = () => {
  try {
    return JSON.parse(fs.readFileSync('./trades.json', 'utf8'))
               .filter(t => t.exitTime)
               .slice(-10);
  } catch (e) {
    console.log(`[WARN] Failed to read trades from file: ${e.message}`);
    return [];
  }
};

// New helper function to read all fills from the historical data file.
const readAllFillsFromFile = () => {
  try {
    const trades = JSON.parse(fs.readFileSync('./trades.json', 'utf8'));
    // Flatten the fills from all closed trades into a single array.
    const allFills = trades.flatMap(trade => trade.fills || []);
    return allFills;
  } catch (e) {
    console.log(`[WARN] Failed to read all fills from file: ${e.message}`);
    return [];
  }
};

function buildLast10ClosedFromRawFills(rawFills, n = 10) {
  // This function body was not provided in the original code, but this is a placeholder
  // implementation to show how it would process fills into closed trades.
  const trades = [];
  let currentTrade = null;
  for (const fill of rawFills) {
    if (!currentTrade) {
      currentTrade = { entryPrice: fill.price, entryTime: fill.timestamp, direction: fill.side, size: fill.size };
    } else if (fill.side !== currentTrade.direction) {
      currentTrade.exitTime = fill.timestamp;
      currentTrade.exitPrice = fill.price;
      trades.push(currentTrade);
      currentTrade = null; // Start a new potential trade
    }
  }
  return trades.filter(t => t.exitTime).slice(-n);
}

/* ---------- enhanced indicator helpers ---------- */
const sma = (arr, len) => arr.slice(-len).reduce((a, b) => a + b, 0) / len;

const atr = (ohlc, len) => {
  const trs = [];
  for (let i = 1; i <= len; i++) {
    const h  = ohlc.at(-i).high;
    const l  = ohlc.at(-i).low;
    const pc = ohlc.at(-i - 1)?.close ?? ohlc.at(-i).close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((a, b) => a + b, 0) / len;
};

const cvdSigma = (fills, lookback = 100) => {
  if (!fills?.length) return { mean: 0, stdev: 1 };
  const deltas = [];
  for (let i = 0; i < fills.length - lookback; i += 1) {
    const slice = fills.slice(i, i + lookback);
    const net   = slice.reduce((s, f) => s + (f.side === 'buy' ? f.size : -f.size), 0);
    deltas.push(net);
  }
  if (!deltas.length) return { mean: 0, stdev: 1 };
  const mean   = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const stdev  = Math.sqrt(deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / deltas.length) || 1;
  return { mean, stdev };
};

export class StrategyEngine {
  constructor() {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const safety = [{ category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }];
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite', safetySettings: safety });
  }

  async _callWithRetry(prompt, max = 4) {
    for (let i = 1; i <= max; i++) {
      try {
        const res = await this.model.generateContent(prompt);
        const text = res.response.text?.();
        if (!text?.length) throw new Error('Empty response');
        return { ok: true, text };
      } catch (err) {
        if (i === max) return { ok: false, error: err };
        console.log(`Call retry ${i} of ${max}`);
        await new Promise(r => setTimeout(r, 61_000));
      }
    }
  }

  _prompt(market) {
    const closes3m  = market.ohlc.map(c => c.close);
    const latest3m  = closes3m.at(-1);

    /* 15-min filter */
    const closes15m = market.ohlc.filter((_, i) => i % 5 === 0).map(c => c.close);
    const sma15_20  = sma(closes15m, 20);

    /* indicators */
    const atr50_3m = atr(market.ohlc, 50);          // smoother 3-min ATR
    const mom3Pct  = ((latest3m - sma(closes3m, 20)) / sma(closes3m, 20) * 100).toFixed(2);
    const volPct   = (atr50_3m / latest3m * 100).toFixed(2);

    /* 24-h intraday range % */
    const today = market.ohlc.slice(-480); // ~24h of 3-min
    const idr24 = ((Math.max(...today.map(c => c.high)) - Math.min(...today.map(c => c.low))) /
                   latest3m * 100).toFixed(2);

    // This is the core change: use historical fills if live data is not present.
    const fills = market.fills?.fills?.length > 0
        ? market.fills.fills
        : readAllFillsFromFile();

    /* micro-structure: CVD over last 30 prints */
    const last30Net = fills.slice(-30)
                            .reduce((s, f) => s + (f.side === 'buy' ? f.size : -f.size), 0);
    const { stdev } = cvdSigma(fills, 100);
    const zScore = stdev ? last30Net / stdev : 0;
    
    // Updated logs to be more clear about the data source.
    if (fills.length > 0) {
      console.log(`[INFO] Using historical fills for CVD calculation. Fills count: ${fills.length}`);
    } else {
      console.log(`[INFO] No fills data found. CVD will be zero.`);
    }

    /* closed trades */
    const last10 = fills.length
      ? buildLast10ClosedFromRawFills(fills, 10)
      : readLast10ClosedTradesFromFile();

    // LOGS ADDED HERE
    console.log(`[DEBUG] last30Net = ${last30Net}, stdev = ${stdev}, zScore = ${zScore.toFixed(2)}`);
    console.log(`[DEBUG] Closed trades: ${JSON.stringify(last10)}`);

    /* prompt */
    return `PF_XBTUSD Alpha Engine – 3-min cycle
You are a high-frequency statistical trader operating exclusively on the PF_XBTUSD perpetual contract.
Each 3-minute candle you emit exactly one JSON decision object.
You do not manage existing positions; you only propose the next intended trade (or cash).
Output schema (mandatory, no extra keys):
{"signal":"LONG"|"SHORT"|"HOLD","confidence":0-100,"stop_loss_distance_in_usd":<positive_number>,"take_profit_distance_in_usd":<positive_number>,"reason":"<max_12_words>"}
You may place a concise reasoning paragraph above the JSON.
The JSON object itself must still be the final, standalone block.

Hard constraints
 1. stop_loss_distance_in_usd
 • Compute 1.2 – 1.8 × 50-period ATR on 3-min candles, round to nearest 0.5 USD.
 • Must be ≥ 0.5 USD.
 2. take_profit_distance_in_usd
 • Compute 1.5 – 4 × chosen SL distance, round to nearest 0.5 USD.
 • If 24h intraday-range% < 1.2 %, use ratio up to 4.0.
 • If 24h intraday-range% > 3 %, cap ratio at 1.5.
 3. confidence
 • 0–29: weak/no edge → HOLD.
 • 30–59: moderate edge.
 • 60–100: strong edge; only when momentum and order-flow agree.

Decision logic (ranked)
A. 15-min momentum filter
 • LONG only if (3-min close > 20-SMA 3-min) AND (15-min close > 20-SMA 15-min) AND (momentum > 0 %).
 • SHORT only if (3-min close < 20-SMA 3-min) AND (15-min close < 20-SMA 15-min) AND (momentum < 0 %).
 • Otherwise HOLD.
B. Volatility regime
 • Use 50-period ATR on 3-min for SL/TP calculation.
 • Adjust TP/SL ratio as above.
C. Micro-structure
 • Compute signed CVD over last 30 fills (Z-score vs 100-fill history).
 • |Z| > 1.5 → +15 confidence for aligned direction, –15 for opposite.
D. Trade frequency guard
 • Skip if last closed position exited < 15 min ago.
E. Risk symmetry
 • SL distance identical in USD for LONG and SHORT signals on same bar.

Reason field
12-word max, e.g. “Long above SMA, bullish delta, SL 1500, TP 3800”.

Candles (3m): ${JSON.stringify(market.ohlc)}
Summary:
- lastClose3m=${latest3m}
- sma20_3m=${sma(closes3m, 20).toFixed(2)}
- sma20_15m=${sma15_20.toFixed(2)}
- momentum3m=${mom3Pct}%
- atr50_3m=${atr50_3m.toFixed(2)}
- 24hIDR%=${idr24}%
- last30CVDz=${zScore.toFixed(2)}
last10=${JSON.stringify(last10)}
`;
  }

  async generateSignal(marketData) {
    if (!marketData?.ohlc?.length) return this._fail('No OHLC');
    
    // Correctly apply the CVD logic based on the fills array.
    const fills = marketData.fills?.fills?.length > 0
        ? marketData.fills.fills
        : readAllFillsFromFile();

    const last30Net = fills.slice(-30).reduce((s, f) => s + (f.side === 'buy' ? f.size : -f.size), 0);
    const { stdev } = cvdSigma(fills, 100);
    const zScore = stdev ? last30Net / stdev : 0;
    
    // And correctly use the last10 logic.
    const last10 = fills.length
      ? buildLast10ClosedFromRawFills(fills, 10)
      : readLast10ClosedTradesFromFile();

    const prompt = this._prompt(marketData);
    const { ok, text, error } = await this._callWithRetry(prompt);
    if (!ok) {
      return this._fail(`API call failed: ${error.message}`);
    }
    try {
      const jsonMatch = text.match(/\{.*\}/s)?.[0];
      const signal = JSON.parse(jsonMatch);
      console.log(`[DEBUG] Successfully parsed signal: ${JSON.stringify(signal)}`);
      return signal;
    } catch (e) {
      return this._fail(`Parse error: ${e.message}`);
    }
  }

  _fail(reason) {
    return { signal: 'HOLD', confidence: 0, stop_loss_distance_in_usd: 0, take_profit_distance_in_usd: 0, reason };
  }
}
