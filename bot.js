import dotenv from 'dotenv';
import fs from 'fs/promises';
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
const MIN_CONF = 25;
const CYCLE_MS = 180_000;
const TRADES_FILE = 'trades.json';

/* ---------- state ---------- */
let sigCnt = 0;
let tradeCnt = 0;
let orderCnt = 0;
// New: A variable to hold all trade records.
const allTrades = [];

/**
 * Saves the current trade history to a JSON file.
 * This function will read the existing file, append the new trades,
 * and write the entire updated array back to disk.
 */
async function saveTradesToFile() {
    try {
        let existingTrades = [];
        try {
            const data = await fs.readFile(TRADES_FILE, 'utf8');
            existingTrades = JSON.parse(data);
        } catch (readError) {
            // File doesn't exist or is empty, which is fine for the first run.
            log.info(`No existing trade file found at ${TRADES_FILE}. Creating a new one.`);
        }
        
        const combinedTrades = [...existingTrades, ...allTrades];
        await fs.writeFile(TRADES_FILE, JSON.stringify(combinedTrades, null, 2), 'utf8');
        log.info(`Trade history saved to ${TRADES_FILE}`);
        
        // Clear the in-memory trades after writing to file to prevent duplicate writes
        allTrades.length = 0;

    } catch (writeError) {
        log.error('Failed to write trade history to file:', writeError.message);
    }
}

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
        log.warn('Not enough 1-minute data to create 3-minute candles.');
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

/* ---------- debugging tool: initial order placement ---------- */

/**
 * Places a single, hardcoded long order with stop loss and take profit for debugging.
 * This function is intended to be used once at startup and should be removed
 * once the core trading logic is confirmed to be working.
 */
async function placeInitialDebugOrder() {
    log.info('--- Debug Mode: Placing initial long order ---');

    try {
        const { KRAKEN_API_KEY, KRAKEN_SECRET_KEY } = process.env;
        if (!KRAKEN_API_KEY || !KRAKEN_SECRET_KEY) {
            log.error('Missing API keys. Cannot place debug order.');
            return;
        }

        const data = new DataHandler(KRAKEN_API_KEY, KRAKEN_SECRET_KEY);
        const exec = new ExecutionHandler(data.api);

        log.info('Fetching current market price for order placement...');
        const rawMarketData = await data.fetchAllData(OHLC_PAIR, 1);
        // The lastPrice is NOT rounded, keeping its fractional value.
        const lastPrice = rawMarketData.ohlc.at(-1).close;
        if (!lastPrice) {
            log.error('Could not fetch last market price. Aborting debug order placement.');
            return;
        }

        // Define trade parameters for the debug order
        // NOTE: These are hardcoded for debugging purposes.
        const size = 0.1; // The trade size is now 0.1.
        const stopLossOffset = 5000; // Hardcoded offset for debugging, at least a few thousand USD away.
        const takeProfitOffset = 5000; // Hardcoded offset for debugging, at least a few thousand USD away.

        const params = {
            size,
            // Only the stop loss and take profit are rounded.
            stopLoss: Math.round(lastPrice - stopLossOffset), // Stop loss below the current price
            takeProfit: Math.round(lastPrice + takeProfitOffset), // Take profit above the current price
        };
        const signal = 'LONG';

        log.info('Debug order parameters:', params); // Log the parameters object explicitly
        await exec.placeOrder({ signal, pair: PAIR, params, lastPrice });
        log.info('Debug order placed successfully.');
        
        // New: Capture and store the trade record without PnL
        const tradeRecord = {
            date: new Date().toISOString(),
            size: params.size,
            side: signal,
            price: lastPrice,
            stopLoss: params.stopLoss,
            takeProfit: params.takeProfit,
            pnl: undefined // PnL is not calculated yet
        };
        allTrades.push(tradeRecord);
        log.info('Debug trade recorded in memory:', tradeRecord);

    } catch (e) {
        log.error('An error occurred while placing the debug order:', e.message);
        log.error('Full error object:', e);
    }
}

// The debug order placement is now active.
// await placeInitialDebugOrder();


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
            // Fetch 1-minute data, which is a supported interval
            const rawMarketData = await data.fetchAllData(OHLC_PAIR, 1);

            // Reconstruct the OHLC data from the raw 1-minute candles
            rawMarketData.ohlc = createThreeMinuteCandles(rawMarketData.ohlc);

            log.info('Market data fetched and aggregated successfully.');
            market = rawMarketData;

        } catch (dataError) {
            log.error('Failed to fetch and process market data:', dataError.message);
            log.error('Full data fetch error object:', dataError);
            return; // Skip the rest of the cycle if data fetch fails
        }

        if (!market || market.balance === undefined || !market.ohlc || !market.ohlc.length) {
            log.warn('Incomplete or invalid market data received after aggregation. Skipping this cycle.');
            return;
        }

        // New: Check for open trades that need PnL calculation
        const lastPrice = market.ohlc.at(-1).close;
        if (allTrades.length > 0) {
            log.info('Checking for open trades to calculate PnL...');
            const tradesToSave = [...allTrades];
            const updatedTrades = [];
            for (const trade of tradesToSave) {
                if (trade.pnl === undefined) {
                    let finalPrice = null;
                    // Check if the current price has crossed the stop loss or take profit level
                    if (trade.side === 'LONG' && (lastPrice <= trade.stopLoss || lastPrice >= trade.takeProfit)) {
                        finalPrice = (lastPrice <= trade.stopLoss) ? trade.stopLoss : trade.takeProfit;
                    } else if (trade.side === 'SHORT' && (lastPrice >= trade.stopLoss || lastPrice <= trade.takeProfit)) {
                        finalPrice = (lastPrice >= trade.stopLoss) ? trade.stopLoss : trade.takeProfit;
                    }

                    if (finalPrice !== null) {
                        // PnL calculation based on side and final price
                        const pnl = (trade.side === 'LONG') 
                            ? (finalPrice - trade.price) * trade.size
                            : (trade.price - finalPrice) * trade.size;
                        
                        // Update the trade record with the calculated PnL
                        trade.pnl = pnl;
                        log.info(`PnL calculated for trade: ${trade.date}. PnL: ${pnl.toFixed(2)}`);
                    }
                }
                updatedTrades.push(trade);
            }
            allTrades.length = 0;
            allTrades.push(...updatedTrades);
        }

        // The rest of the trading logic remains the same
        const open = market.positions?.openPositions?.filter(p => p.symbol === PAIR) || [];

        if (open.length) {
            log.info('Position open; skipping trading logic.');
            return;
        }

        let signal;
        try {
            log.info('Generating trading signal...');
            signal = await strat.generateSignal(market);
            log.info(`Generated signal: ${signal.signal}, Confidence: ${signal.confidence}`);
        } catch (signalError) {
            log.error('Failed to generate trading signal:', signalError.message);
            log.error('Full signal generation error object:', signalError);
            return;
        }

        if (signal.signal !== 'HOLD' && signal.confidence >= MIN_CONF) {
            log.info(`Signal meets confidence threshold (${MIN_CONF}). Calculating trade parameters...`);
            const params = risk.calculateTradeParameters(market, signal);

            // Add a log to show the calculated trade parameters
            log.info('Calculated trade parameters:', params);

            if (params) {
                log.info('Trade parameters calculated. Attempting to place order...');
                const lastPrice = market.ohlc.at(-1).close;
                try {
                    await exec.placeOrder({ signal: signal.signal, pair: PAIR, params, lastPrice });
                    log.info('Order placed successfully.');
                    
                    // New: Create the trade record without PnL
                    const tradeRecord = {
                        date: new Date().toISOString(),
                        size: params.size,
                        side: signal.signal,
                        price: lastPrice,
                        stopLoss: params.stopLoss,
                        takeProfit: params.takeProfit,
                        pnl: undefined // PnL is not calculated yet
                    };
                    allTrades.push(tradeRecord);
                    log.info('Trade recorded in memory:', tradeRecord);
                    
                } catch (orderError) {
                    log.error('Failed to place order:', orderError.message);
                    log.error('Full order placement error object:', orderError);
                }
            } else {
                log.warn('Could not calculate valid trade parameters. Skipping trade.');
            }
        } else {
            log.info(`Signal is 'HOLD' or confidence is too low (${signal.confidence} < ${MIN_CONF}). No trade will be placed.`);
        }
    } catch (e) {
        log.error('An unexpected error occurred during the trading cycle:', e.message);
        log.error('Full unexpected error object:', e);
    } finally {
        log.info('--- cycle finished ---');
        // New: Save trades to file at the end of each cycle if there are new trades.
        if (allTrades.length > 0) {
            await saveTradesToFile();
        }
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
    // Save any pending trades before exiting
    if (allTrades.length > 0) {
        saveTradesToFile().finally(() => process.exit(0));
    } else {
        process.exit(0);
    }
});
