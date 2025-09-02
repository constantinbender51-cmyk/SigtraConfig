import dotenv from 'dotenv';
import fs from 'fs/promises';
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
const MIN_CONF = 25;
const CYCLE_MS = 180_000;
const TRADE_LOG_FILE = 'trades.json';
// New array of timeframes to fetch data for (in minutes)
const TIME_FRAMES_MINUTES = {
    '1 hour': 60,
    '4 hour': 240,
    '1 day': 1440,
    '1 week': 10080
};

/* ---------- state ---------- */
let wasPositionOpen = true; 
let lastTradeDetails = null; 
let lastBalance = null; 

/* ---------- helpers ---------- */

/**
 * Reads the trade log file, adds a new trade entry or updates an existing one, and writes the file back.
 * @param {object} tradeDetails - The trade object to be logged.
 */
const logTrade = async (tradeDetails) => {
    try {
        let trades = [];
        try {
            const data = await fs.readFile(TRADE_LOG_FILE, 'utf8');
            trades = JSON.parse(data);
        } catch (readError) {
            if (readError.code === 'ENOENT') {
                log.info(`Creating new trade log file: ${TRADE_LOG_FILE}`);
            } else {
                throw readError;
            }
        }

        const existingTradeIndex = trades.findIndex(trade => trade.id === tradeDetails.id);

        if (existingTradeIndex !== -1) {
            trades[existingTradeIndex] = tradeDetails;
            log.info(`Overwriting existing trade with ID: ${tradeDetails.id}.`);
        } else {
            trades.push(tradeDetails);
            log.info(`New trade entry added with ID: ${tradeDetails.id}.`);
        }

        await fs.writeFile(TRADE_LOG_FILE, JSON.stringify(trades, null, 2), 'utf8');
        log.info(`Trade details successfully logged to ${TRADE_LOG_FILE}.`);
    } catch (error) {
        log.error('Failed to log trade details:', error);
    }
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

        // Step 1: Fetch OHLC data for all specified timeframes
        log.info('Fetching OHLC data for all timeframes: 1h, 4h, 1d, 1w...');
        const allOhlcData = {};
        for (const [name, interval] of Object.entries(TIME_FRAMES_MINUTES)) {
            try {
                const ohlc = await data.fetchOhlcData(OHLC_PAIR, interval);
                allOhlcData[name] = ohlc;
                log.info(`Successfully fetched ${name} data.`);
            } catch (dataError) {
                log.error(`Failed to fetch ${name} data:`, dataError);
            }
        }

        if (Object.keys(allOhlcData).length === 0) {
            log.warn('Skipping cycle due to missing OHLC data for all timeframes.');
            return;
        }

        // Step 2: Use AI to select the most interesting timeframe
        log.info('Asking AI to select the most interesting timeframe to trade on...');
        const timeframeDecision = await strat.selectTimeframe(allOhlcData);
        log.info(`AI recommends trading on the ${timeframeDecision.timeframe} timeframe. Reason: ${timeframeDecision.reason}`);

        const chosenTimeframeName = timeframeDecision.timeframe;
        const chosenTimeframeMinutes = TIME_FRAMES_MINUTES[chosenTimeframeName];

        // Step 3: Fetch all market data for the chosen timeframe
        let market;
        try {
            const rawMarketData = await data.fetchAllData(OHLC_PAIR, chosenTimeframeMinutes);
            log.info(`Data fetched for ${OHLC_PAIR} on the ${chosenTimeframeName} timeframe.`);
            market = rawMarketData;
        } catch (dataError) {
            log.error('Failed to fetch market data for the chosen timeframe:', dataError);
            return;
        }

        if (!market || market.balance === undefined || !market.ohlc || !market.ohlc.length) {
            log.warn('Skipping cycle due to missing market data or balance for the chosen timeframe.');
            return;
        }

        const open = market.positions?.openPositions?.filter(p => p.symbol === PAIR) || [];

        if (open.length) {
            log.info('An open position already exists. Skipping signal generation.');
            wasPositionOpen = true;
        } else {
            if (wasPositionOpen) {
                if (lastTradeDetails && lastBalance !== null) {
                    const pnl = market.balance - lastBalance;
                    const closedTrade = { ...lastTradeDetails, pnl: pnl.toFixed(2) };
                    await logTrade(closedTrade);
                    log.info(`Trade closed. PnL: ${pnl.toFixed(2)} USD.`);
                }
                lastBalance = market.balance;
                log.info(`New balance: ${market.balance.toFixed(2)} USD.`);
                lastTradeDetails = null; 
                wasPositionOpen = false;
            }

            // Step 4: Generate a signal for the chosen timeframe
            let signal;
            try {
                signal = await strat.generateSignal(market, chosenTimeframeName);
                log.info(`Signal generated for ${chosenTimeframeName}: ${signal.signal} with confidence ${signal.confidence}.`);
            } catch (signalError) {
                log.error('Failed to generate trading signal:', signalError);
                return;
            }

            if (signal.signal !== 'HOLD' && signal.confidence >= MIN_CONF) {
                const params = risk.calculateTradeParameters(market, signal);

                if (params) {
                    const lastPrice = market.ohlc.at(-1).close;
                    try {
                        const orderResult = await exec.placeOrder({ signal: signal.signal, pair: PAIR, params, lastPrice });
                        const tradeLog = {
                            id: orderResult.sendStatus.order_id,
                            side: signal.signal,
                            size: params.size,
                            lastPrice: lastPrice,
                            stopLoss: params.stopLoss,
                            takeProfit: params.takeProfit,
                            pnl: null
                        };

                        lastTradeDetails = tradeLog;
                        await logTrade(tradeLog);

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
