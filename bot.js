// bot.js – enhanced with robust error handling and logging
import dotenv from 'dotenv';
import { startWebServer } from './webServer.js';
import { DataHandler } from './dataHandler.js';
import { StrategyEngine } from './strategyEngine.js';
import { RiskManager } from './riskManager.js';
import { ExecutionHandler } from './executionHandler.js';
import { log } from './logger.js';

dotenv.config();
startWebServer();

/* ---------- constants ---------- */
const PAIR = 'PF_XBTUSD';
const OHLC_PAIR = 'XBTUSD';
// The Kraken API supports intervals of 1, 5, 15, 30, 60, 240, 1440, etc.
// The bot's desired interval is 3 minutes, which we will now construct.
const INTERVAL = 3;
const MIN_CONF = 40;
const CYCLE_MS = 1_800_000;

/* ---------- state ---------- */
let sigCnt = 0;
let tradeCnt = 0;
let orderCnt = 0;

let firstBalance = null;     // balance when first flat
let lastBalance = null;      // balance on last flat cycle
let curBalance = null;

const returns = [];          // daily % returns
const pnls = [];             // closed-trade PnLs
const equity = [];           // balance history for DD

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
            log.error('Missing API keys. Please set KRAKEN_API_KEY and KRAKEN_SECRET_KEY in your .env file.');
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
            log.error('Failed to fetch and process market data:', dataError.message);
            log.debug('Full data fetch error object:', dataError);
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

        const open = market.positions?.openPositions?.filter(p => p.symbol === PAIR) || [];

        if (!open.length && lastBalance !== null) {
            const pnl = curBalance - firstBalance;
            pnls.push(pnl);
            log.info(`Position closed. Realized PnL: ${pnl} USD`);
            recordStats();
            lastBalance = curBalance; 
        }

        if (firstBalance === null && !open.length) {
            firstBalance = lastBalance = curBalance;
            log.metric('initial_balance', firstBalance, 'USD');
        }

        if (open.length) {
            log.info('Position open; skipping trading logic.');
            return;
        }

        let signal;
        try {
            log.info('Generating trading signal...');
            signal = await strat.generateSignal(market);
            log.metric('signal_cnt', ++sigCnt);
        } catch (signalError) {
            log.error('Failed to generate trading signal:', signalError.message);
            log.debug('Full signal generation error object:', signalError);
            return;
        }

        if (signal.signal !== 'HOLD' && signal.confidence >= MIN_CONF) {
            log.info(`Signal generated: ${signal.signal}, Confidence: ${signal.confidence}. Signal meets confidence threshold of ${MIN_CONF}.`);
            
            log.info('Calculating trade parameters...');
            const params = risk.calculateTradeParameters(market, signal);

            if (params) {
                log.info(`Trade parameters calculated. Quantity: ${params.volume}, Stop Loss: ${params.stopLoss}, Take Profit: ${params.takeProfit}`);
                log.info('Attempting to place order...');
                log.metric('trade_cnt', ++tradeCnt);
                const lastPrice = market.ohlc.at(-1).close;
                try {
                    await exec.placeOrder({ signal: signal.signal, pair: PAIR, params, lastPrice });
                    log.metric('order_cnt', ++orderCnt);
                    log.info('Order placed successfully.');
                } catch (orderError) {
                    log.error('Failed to place order:', orderError.message);
                    log.debug('Full order placement error object:', orderError);
                }
            } else {
                log.warn('Could not calculate valid trade parameters. Skipping trade.');
            }
        } else {
            log.info(`Signal generated: ${signal.signal}, Confidence: ${signal.confidence}. No trade will be placed as signal is 'HOLD' or confidence is too low.`);
        }
    } catch (e) {
        log.error('An unexpected error occurred during the trading cycle:', e.message);
        log.debug('Full unexpected error object:', e);
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
