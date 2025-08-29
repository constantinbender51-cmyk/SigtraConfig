// bot.js – simplified, functional version
import dotenv from 'dotenv';
import { startWebServer } from './webServer.js';
import { DataHandler } from './dataHandler.js';
import { StrategyEngine } from './strategyEngine.js';
import { RiskManager } from './riskManager.js';
import { ExecutionHandler } from './executionHandler.js';

// Load environment variables and start the web server
dotenv.config();
startWebServer();

/* ---------- constants ---------- */
const PAIR = 'PF_XBTUSD';
const OHLC_PAIR = 'XBTUSD';
const INTERVAL = 3;
const MIN_CONF = 25;
const CYCLE_MS = 180_000;

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
            market = rawMarketData;
        } catch (dataError) {
            return;
        }

        if (!market || market.balance === undefined || !market.ohlc || !market.ohlc.length) {
            return;
        }

        const open = market.positions?.openPositions?.filter(p => p.symbol === PAIR) || [];
        if (open.length) {
            return;
        }

        let signal;
        try {
            signal = await strat.generateSignal(market);
        } catch (signalError) {
            return;
        }

        if (signal.signal !== 'HOLD' && signal.confidence >= MIN_CONF) {
            const params = risk.calculateTradeParameters(market, signal);

            if (params) {
                const lastPrice = market.ohlc.at(-1).close;
                try {
                    await exec.placeOrder({ signal: signal.signal, pair: PAIR, params, lastPrice });
                } catch (orderError) {
                    return;
                }
            }
        }
    } catch (e) {
        // All non-essential logging and error handling has been removed.
    } finally {
        // No logging on cycle completion.
    }
}

/* ---------- loop ---------- */
function loop() {
    cycle().finally(() => setTimeout(loop, CYCLE_MS));
}

loop();

/* ---------- graceful shutdown ---------- */
process.on('SIGINT', () => {
    process.exit(0);
});
