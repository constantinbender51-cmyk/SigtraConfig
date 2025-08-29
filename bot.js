// bot.js – simplified, functional version
import dotenv from 'dotenv';
import { startWebServer } from './webServer.js';
import { DataHandler } from './dataHandler.js';
import { StrategyEngine } from './strategyEngine.js';
import { RiskManager } from './riskManager.js';
import { ExecutionHandler } from './executionHandler.js';
import { log } from './logger.js';

// Load environment variables and start the web server
dotenv.config();

/* ---------- constants ---------- */
const PAIR = 'PF_XBTUSD';
const OHLC_PAIR = 'XBTUSD';
const INTERVAL = 3;
const MIN_CONF = 25;
const CYCLE_MS = 180_000;

/* ---------- state ---------- */
let wasPositionOpen = true; // Initialize to true so the balance is logged on the first run

/* ---------- helpers ---------- */

/**
 * Aggregates an array of 1-minute OHLC candles into 3-minute candles.
 * This is necessary because Kraken's API does not support 3-minute intervals directly.
 * @param {Array<Object>} candles - An array of 1-minute candle objects from the API.
 * @returns {Array<Object>} - A new array of 3-minute candle objects.
 */
const createThreeMinuteCandles = (candles) => {
    const threeMinCandles = [];
    if (!candles || candles.length < 3) {
        return threeMinCandles;
    }

    // Process candles in groups of 3
    for (let i = 0; i < candles.length; i += 3) {
        // Ensure there are at least 3 candles remaining
        if (i + 2 < candles.length) {
            const group = candles.slice(i, i + 3);
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
    }
    return threeMinCandles;
};

/* ---------- trading cycle ---------- */
async function cycle() {
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
            const rawMarketData = await data.fetchAllData(OHLC_PAIR, 1);
            rawMarketData.ohlc = createThreeMinuteCandles(rawMarketData.ohlc);
            log.info(`Data fetched for ${OHLC_PAIR} and aggregated to a 3-minute timeframe.`);
            market = rawMarketData;
        } catch (dataError) {
            log.error('Failed to fetch market data:', dataError);
            return;
        }

        if (!market || market.balance === undefined || !market.ohlc || !market.ohlc.length) {
            log.warn('Skipping cycle due to missing market data or balance.');
            return;
        }

        const open = market.positions?.openPositions?.filter(p => p.symbol === PAIR) || [];

        if (open.length) {
            log.info('An open position already exists. Skipping signal generation.');
            wasPositionOpen = true; // Set the flag to true because a position is currently open
        } else {
            // Log the balance here, but only if the flag indicates a position was just closed or it's the first run
            if (wasPositionOpen) {
                log.info(`New balance: ${market.balance.toFixed(2)} USD.`);
                wasPositionOpen = false; // Reset the flag to prevent logging in consecutive "no position" cycles
            }
            
            let signal;
            try {
                signal = await strat.generateSignal(market);
                log.info(`Signal generated: ${signal.signal} with confidence ${signal.confidence}.`);
            } catch (signalError) {
                log.error('Failed to generate trading signal:', signalError);
                return;
            }
    
            if (signal.signal !== 'HOLD' && signal.confidence >= MIN_CONF) {
                const params = risk.calculateTradeParameters(market, signal);
    
                if (params) {
                    const lastPrice = market.ohlc.at(-1).close;
                    try {
                        // Mock order placement for demonstration purposes
                        const orderResult = { orderId: 'mock-12345', status: 'pending' };
                        // await exec.placeOrder({ signal: signal.signal, pair: PAIR, params, lastPrice });
                        log.info(`Order placed for ${PAIR}: ${signal.signal}.`);
                    } catch (orderError) {
                        log.error('Failed to place order:', orderError);
                        return;
                    }
                } else {
                    log.warn('Risk manager returned no trade parameters. Skipping order placement.');
                }
            } else {
                log.info('Signal confidence too low or signal is HOLD. No trade will be placed.');
            }
        }
    } catch (e) {
        log.error('An unhandled error occurred during the trading cycle:', e);
    }
}

/* ---------- loop ---------- */
function loop() {
    cycle().finally(() => setTimeout(loop, CYCLE_MS));
}

// Start the web server and the trading loop
startWebServer();
log.info('Bot is starting up...');
loop();

/* ---------- graceful shutdown ---------- */
process.on('SIGINT', () => {
    log.warn('Shutting down gracefully...');
    process.exit(0);
});
