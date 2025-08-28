// bot.js – enhanced with robust error handling and logging
import dotenv from 'dotenv';
import { startWebServer } from './webServer.js';
import { DataHandler } from './dataHandler.js';
import { StrategyEngine } from './strategyEngine.js';
import { RiskManager } from './riskManager.js';
import { ExecutionHandler } from './executionHandler.js';
import { log } from './logger.js';

dotenv.config();

// Starting the web server and logging the event
log.info('Starting web server...');
startWebServer();

/* ---------- constants ---------- */
const PAIR = 'PF_XBTUSD';
const OHLC_PAIR = 'XBTUSD';
const INTERVAL = 3;
const MIN_CONF = 40;
const CYCLE_MS = 180000;

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
    // Log the start of the aggregation process
    log.info(`Attempting to aggregate 1-minute candles into ${desiredCount} 3-minute candles.`);
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
    log.info(`Aggregating the last ${relevantCandles.length} 1-minute candles.`);

    // Process candles in groups of 3
    for (let i = 0; i < relevantCandles.length; i += 3) {
        const group = relevantCandles.slice(i, i + 3);
        // Log the details of each new candle being created
        log.info(`Creating 3-minute candle from 1-minute candles ending at: ${new Date(group[2].time * 1000).toISOString()}`);
        const newCandle = {
            open: group[0].open,
            high: Math.max(...group.map(c => c.high)),
            low: Math.min(...group.map(c => c.low)),
            close: group[2].close,
            volume: group.reduce((sum, c) => sum + c.volume, 0),
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

    // Using metric logging to record key stats
    log.metric('realised_pnl', pnls.reduce((a, b) => a + b, 0), 'USD');
    log.metric('trade_count', pnls.length);
    log.metric('win_rate', pnls.length ? ((wins / pnls.length) * 100).toFixed(1) : 0, '%');
    log.metric('profit_factor', grossL ? (grossW / grossL).toFixed(2) : '—');

    const peak = Math.max(...equity);
    // Using structured data for the max_drawdown metric
    log.metric('max_drawdown', peak ? (((peak - curBalance) / peak) * 100).toFixed(2) : 0, '%', { peak, current: curBalance });

    if (returns.length >= 2) log.metric('sharpe_30d', annualise(returns).toFixed(2));
};

/* ---------- trading cycle ---------- */
async function cycle() {
    log.info(`--- Starting a new trading cycle for ${PAIR} ---`);

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
            log.info('Fetching market data (1-minute interval) from Kraken...');
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
            // More specific warning for data issues
            log.warn('Incomplete or invalid market data received after aggregation. Skipping this cycle.', {
                hasBalance: market?.balance !== undefined,
                hasOhlc: Array.isArray(market?.ohlc) && market.ohlc.length > 0
            });
            return;
        }

        curBalance = market.balance;
        equity.push(curBalance);
        log.info(`Current balance: ${curBalance.toFixed(2)} USD`);
        log.metric('current_balance', curBalance, 'USD');

        if (lastBalance !== null) {
            const dailyReturn = (curBalance - lastBalance) / lastBalance;
            returns.push(dailyReturn);
            if (returns.length > 30) returns.shift();
            log.info(`Daily return calculated and recorded. Value: ${(dailyReturn * 100).toFixed(2)}%`);
        }

        const open = market.positions?.openPositions?.filter(p => p.symbol === PAIR) || [];

        // Log when the bot is flat (no open positions)
        if (!open.length) {
            if (lastBalance !== null) {
                const pnl = curBalance - firstBalance;
                pnls.push(pnl);
                log.info(`Position closed. Realized PnL: ${pnl.toFixed(2)} USD`);
                recordStats();
                lastBalance = curBalance;
            } else if (firstBalance === null) {
                firstBalance = lastBalance = curBalance;
                log.metric('initial_balance', firstBalance, 'USD');
                log.info(`Initial balance set to: ${firstBalance.toFixed(2)} USD`);
            }
        } else {
            // Log details about the open position
            const openPositionsCount = open.length;
            const firstPosition = open[0];
            log.info(`Position is open (count: ${openPositionsCount}); skipping trading logic for this cycle.`, {
                symbol: firstPosition.symbol,
                side: firstPosition.side,
                size: firstPosition.size,
                openPrice: firstPosition.openPrice
            });
            return;
        }

        let signal;
        try {
            log.info('Generating trading signal...');
            signal = await strat.generateSignal(market);
            log.metric('signal_cnt', ++sigCnt);
            // Log signal details with structured data
            log.info('Signal generated.', { signal: signal.signal, confidence: signal.confidence });
        } catch (signalError) {
            log.error('Failed to generate trading signal.', signalError);
            return;
        }

        if (signal.signal !== 'HOLD' && signal.confidence >= MIN_CONF) {
            log.info(`Signal meets confidence threshold (${signal.confidence} >= ${MIN_CONF}). Proceeding with trade parameter calculation.`);

            const params = risk.calculateTradeParameters(market, signal);

            if (params) {
                // Log calculated parameters with structured data for easy analysis
                log.info('Trade parameters calculated.', {
                    volume: params.volume,
                    stopLoss: params.stopLoss,
                    takeProfit: params.takeProfit,
                });
                log.metric('trade_cnt', ++tradeCnt);
                const lastPrice = market.ohlc.at(-1).close;
                try {
                    log.info(`Attempting to place a '${signal.signal}' order...`);
                    const orderResponse = await exec.placeOrder({ signal: signal.signal, pair: PAIR, params, lastPrice });
                    if (orderResponse.result === 'success') {
                         log.metric('order_cnt', ++orderCnt);
                         log.info('Order placed successfully.');
                    } else {
                         log.error('Failed to place order. API response indicates failure.', orderResponse);
                    }
                } catch (orderError) {
                    log.error('Failed to place order.', orderError);
                }
            } else {
                log.warn('Could not calculate valid trade parameters. Skipping trade.', { reason: 'risk_manager_failure' });
            }
        } else {
            // Log why no trade was placed
            log.info(`No trade will be placed. Signal is '${signal.signal}' or confidence is too low.`, {
                confidence: signal.confidence,
                minConfidence: MIN_CONF
            });
        }
    } catch (e) {
        log.error('An unexpected error occurred during the trading cycle.', e);
    } finally {
        log.info('--- Cycle finished ---');
    }
}

/* ---------- loop ---------- */
function loop() {
    log.info('Starting main trading loop...');
    cycle().finally(() => setTimeout(loop, CYCLE_MS));
}

loop();

/* ---------- graceful shutdown ---------- */
process.on('SIGINT', () => {
    log.warn('SIGINT received – shutting down gracefully.');
    process.exit(0);
});
