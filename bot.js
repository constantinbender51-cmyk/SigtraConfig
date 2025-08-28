// bot.js – enhanced with robust error handling, logging, and trade history
import dotenv from 'dotenv';
import { startWebServer } from './webServer.js';
import { DataHandler } from './dataHandler.js';
import { StrategyEngine } from './strategyEngine.js';
import { RiskManager } from './riskManager.js';
import { ExecutionHandler } from './executionHandler.js';
import { log } from './logger.js';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

// Start the web server
startWebServer();

/* ---------- constants ---------- */
const PAIR = 'PF_XBTUSD';
const OHLC_PAIR = 'XBTUSD';
// The Kraken API supports intervals of 1, 5, 15, 30, 60, 240, 1440, etc.
// The bot's desired interval is 3 minutes, which we will now construct.
const INTERVAL = 3;
const MIN_CONF = 25;
const CYCLE_MS = 180000;
const TRADES_LOG_FILE = path.join(process.cwd(), 'logs', 'trades.ndjson');

/* ---------- state ---------- */
let sigCnt = 0;
let tradeCnt = 0;
let orderCnt = 0;
// Track whether exit orders (stop loss/take profit) have been placed for the current position
let exitOrdersPlaced = false;

let firstBalance = null;      // balance when first flat
let lastBalance = null;       // balance on last flat cycle
let curBalance = null;

const returns = [];           // daily % returns
const pnls = [];              // closed-trade PnLs
const equity = [];            // balance history for DD

/* ---------- helpers ---------- */

/**
 * Aggregates a fixed number of 1-minute OHLC candles into 3-minute candles.
 * This function is now designed to return a specific number of candles.
 * @param {Array<Object>} candles - An array of 1-minute candle objects from the API.
 * @param {number} desiredCount - The number of 3-minute candles to produce.
 * @returns {Array<Object>} - A new array of 3-minute candle objects.
 */
const createThreeMinuteCandles = (candles, desiredCount) => {
    const threeMinCandles = [];
    // To get N 3-minute candles, we need 3 * N 1-minute candles.
    const neededCandles = desiredCount * 3;

    // Check if we have enough raw data to create the desired number of candles.
    if (!candles || candles.length < neededCandles) {
        log.warn(`Not enough 1-minute data to create ${desiredCount} 3-minute candles. Needed: ${neededCandles}, Got: ${candles.length || 0}.`);
        return threeMinCandles;
    }

    // Slice the original array to get only the most recent 'neededCandles'
    const relevantCandles = candles.slice(-neededCandles);

    // Process candles in groups of 3
    for (let i = 0; i < relevantCandles.length; i += 3) {
        const group = relevantCandles.slice(i, i + 3);
        const newCandle = {
            // The open price is the open of the first candle in the group
            open: group[0].open,
            // The highest price is the maximum high from all candles in the group
            high: Math.max(...group.map(c => c.high)),
            // The lowest price is the minimum low from all candles in the group
            low: Math.min(...group.map(c => c.low)),
            // The close price is the close of the last candle in the group
            close: group[2].close,
            // The volume is the sum of volumes from all candles in the group
            volume: group.reduce((sum, c) => sum + c.volume, 0),
            // The timestamp is the timestamp of the last candle in the group
            time: group[2].time
        };
        threeMinCandles.push(newCandle);
    }
    return threeMinCandles;
};

/**
 * Logs a new trade to the trades log file.
 * We'll use this to persist the trade data for the new web page.
 * @param {object} tradeData - The data for the completed trade.
 */
const logTrade = (tradeData) => {
    try {
        const tradeRecord = JSON.stringify(tradeData);
        fs.appendFileSync(TRADES_LOG_FILE, tradeRecord + '\n');
        log.info('Trade successfully logged to file.');
    } catch (err) {
        log.error('Failed to log trade to file.', err);
    }
};

const annualise = (arr) => {
    if (arr.length < 2) return 0;
    const μ = arr.reduce((a, b) => a + b, 0) / arr.length;
    const σ = Math.sqrt(arr.map(r => (r - μ) ** 2).reduce((a, b) => a + b, 0) / (arr.length - 1));
    return σ ? (μ / σ) * Math.sqrt(252) : 0;
};

const recordStats = () => {
    const wins = pnls.filter(p => p > 0).length;
    const grossW = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const grossL = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));

    log.metric('realised_pnl', pnls.reduce((a, b) => a + b, 0), 'USD');
    log.metric('trade_count', pnls.length);
    log.metric('win_rate', pnls.length ? ((wins / pnls.length) * 100).toFixed(1) : 0, '%');
    log.metric('profit_factor', grossL ? (grossW / grossL).toFixed(2) : '—');

    const peak = Math.max(...equity);
    log.metric('max_drawdown', peak ? (((peak - curBalance) / peak) * 100).toFixed(2) : 0, '%');

    if (returns.length >= 2) log.metric('sharpe_30d', annualise(returns).toFixed(2));
};

/* ---------- trading cycle ---------- */
async function cycle() {
    log.info(`--- starting cycle for ${PAIR} ---`);

    try {
        const { KRAKEN_API_KEY, KRAKEN_SECRET_KEY } = process.env;
        if (!KRAKEN_API_KEY || !KRAKEN_SECRET_KEY) {
            log.error('Missing API keys. Please set KRAKEN_API_KEY and KRAKEN_SECRET_KEY in your .env file.', new Error('Missing environment variables'));
            return;
        }

        const data = new DataHandler(KRAKEN_API_KEY, KRAKEN_SECRET_KEY);
        const strat = new StrategyEngine();
        const risk = new RiskManager({ leverage: 10, stopLossMultiplier: 2, takeProfitMultiplier: 3, marginBuffer: 0.4 });
        const exec = new ExecutionHandler(data.api);

        let market;
        try {
            log.info('Fetching market data (1-minute interval)...');
            // Fetch 1-minute data, which is a supported interval.
            const rawMarketData = await data.fetchAllData(OHLC_PAIR, 1);

            // Reconstruct the OHLC data from the raw 1-minute candles, ensuring we get exactly 52 candles.
            const aggregatedCandles = createThreeMinuteCandles(rawMarketData.ohlc, 52);
            rawMarketData.ohlc = aggregatedCandles;

            log.info(`Market data fetched and aggregated successfully. Got ${aggregatedCandles.length} candles.`);
            market = rawMarketData;

        } catch (dataError) {
            log.error('Failed to fetch and process market data.', dataError);
            return; // Skip the rest of the cycle if data fetch fails
        }

        if (!market || market.balance === undefined || !market.ohlc || !market.ohlc.length) {
            log.warn('Incomplete or invalid market data received after aggregation. Skipping this cycle.');
            return;
        }

        curBalance = market.balance;
        equity.push(curBalance);
        log.info(`Current balance: ${curBalance} USD`);

        if (lastBalance !== null) {
            returns.push((curBalance - lastBalance) / lastBalance);
            if (returns.length > 30) returns.shift();
            log.info(`Daily return recorded. Returns array length: ${returns.length}`);
        }

        const openPositions = market.positions?.openPositions?.filter(p => p.symbol === PAIR) || [];
        // Check if there are any open orders related to our trading pair that might be pending.
        const openOrders = market.openOrders?.openOrders?.filter(o => o.symbol === PAIR) || [];

        // Condition 1: Position was just closed.
        if (!openPositions.length && lastBalance !== null) {
            const pnl = curBalance - firstBalance;
            pnls.push(pnl);
            log.info(`Position closed. Realized PnL: ${pnl} USD`);

            // --- NEW: Log the closed trade to file ---
            // Note: In a real-world scenario, you would have more detailed trade data
            // such as entry/exit price and side (long/short). For this example,
            // we'll log what we have available.
            const tradeData = {
                timestamp: new Date().toISOString(),
                pnl: pnl,
                tradeId: `trade_${pnls.length}`
            };
            logTrade(tradeData);
            // ----------------------------------------

            recordStats();
            lastBalance = curBalance;
            // Reset the flag for exit orders when the position is closed.
            exitOrdersPlaced = false;
        }

        if (firstBalance === null && !openPositions.length) {
            firstBalance = lastBalance = curBalance;
            log.metric('initial_balance', firstBalance, 'USD');
        }

        // Condition 2: A position is open. We need to manage exits.
        if (openPositions.length) {
            log.info(`Position open; checking for stop-loss and take-profit orders.`);
            // If the position exists, but exit orders haven't been placed yet, place them now.
            // This handles partial fills from the previous cycle.
            if (!exitOrdersPlaced) {
                 const params = risk.calculateTradeParameters(market, { signal: openPositions[0].side });
                 // Ensure we have valid params before trying to place orders
                 if (params) {
                    await exec.placeExitOrders({
                        pair: PAIR,
                        params,
                        filledSize: openPositions[0].size,
                    });
                    exitOrdersPlaced = true;
                    log.metric('order_cnt', ++orderCnt);
                 } else {
                     log.warn("Could not calculate valid exit parameters. Skipping exit order placement.");
                 }
            } else {
                log.info('Exit orders are already in place for the current position.');
            }
            return;
        }

        // Condition 3: No position is open. Look for a new signal to enter.
        let signal;
        try {
            log.info('Generating trading signal...');
            signal = await strat.generateSignal(market);
            log.metric('signal_cnt', ++sigCnt);
        } catch (signalError) {
            log.error('Failed to generate trading signal.', signalError);
            return;
        }

        if (signal.signal !== 'HOLD' && signal.confidence >= MIN_CONF) {
            log.info(`Signal generated: ${signal.signal}, Confidence: ${signal.confidence}. Signal meets confidence threshold of ${MIN_CONF}.`);

            const params = risk.calculateTradeParameters(market, signal);

            if (params) {
                log.info(`Trade parameters calculated successfully. Quantity: ${params.volume}`);
                log.metric('trade_cnt', ++tradeCnt);
                const lastPrice = market.ohlc.at(-1).close;
                try {
                    // Refactored: We now only place the entry order. Exits are handled in the next cycle.
                    await exec.placeEntryOrder({ signal: signal.signal, pair: PAIR, params, lastPrice });
                    // No need to set exitOrdersPlaced to true here, as exits are not yet placed.
                    log.info('Entry order placed successfully. Awaiting fills...');
                } catch (orderError) {
                    log.error('Failed to place entry order.', orderError);
                }
            } else {
                log.warn('Could not calculate valid trade parameters. Skipping trade.');
            }
        } else {
            log.info(`Signal generated: ${signal.signal}, Confidence: ${signal.confidence}. No trade will be placed as signal is 'HOLD' or confidence is too low.`);
        }
    } catch (e) {
        log.error('An unexpected error occurred during the trading cycle.', e);
    } finally {
        log.info('--- cycle finished ---');
    }
}

/* ---------- loop ---------- */
function loop() {
    cycle().finally(() => setTimeout(loop, CYCLE_MS));
}

loop();

/* ---------- graceful shutdown ---------- */
process.on('SIGINT', () => {
    log.warn('SIGINT received – shutting down');
    process.exit(0);
});

