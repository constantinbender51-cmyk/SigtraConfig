import dotenv from 'dotenv';
import fs from 'fs/promises';
import { startWebServer } from './webServer.js';
import { DataHandler } from './dataHandler.js';
import { StrategyEngine } from './strategyEngine.js';
import { RiskManager } from './riskManager.js';
import { ExecutionHandler } from './executionHandler.js';
import { log } from './logger.js';
import axios from 'axios';

dotenv.config();

const PAIR = 'PF_XBTUSD';
const OHLC_PAIR = 'XBTUSD';
const INTERVALS = {
    '1 hour': 60,
    '4 hour': 240,
    '1 day': 1440,
    '1 week': 10080
};
const MIN_CONF = 0;
let CYCLE_MS = 1000 * 60 * 60;
const TRADE_LOG_FILE = 'trades.json';
const SPOT_OHLC_URL = 'https://api.kraken.com/0/public/OHLC';

let wasPositionOpen = true;
let lastTradeDetails = null;
let lastBalance = null;
let commit = {};
let TfConsist = 0;

// Helper function to create a delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// New function to log large data in smaller chunks to avoid rate limits
async function logInChunks(title, data, chunkSize = 5000, delay = 1000) {
    try {
        const jsonString = JSON.stringify(data, null, 2);
        const totalChunks = Math.ceil(jsonString.length / chunkSize);
        log.info(`${title} - Logging in ${totalChunks} chunks to prevent rate limits.`);
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = start + chunkSize;
            const chunk = jsonString.substring(start, end);
            log.info(`${title} (Part ${i + 1}/${totalChunks}):\n`, chunk);
            // Add delay between chunks
            if (i < totalChunks - 1) {
                await sleep(delay);
            }
        }
    } catch (e) {
        log.error(`Failed to log data in chunks for "${title}":`, e);
    }
}

const fetchKrakenData = async ({ pair = 'XBTUSD', interval, since } = {}) => {
    const params = { pair, interval };
    if (since) params.since = since;
    try {
        const { data } = await axios.get(SPOT_OHLC_URL, { params });
        if (data.error?.length) throw new Error(data.error.join(', '));
        const key = Object.keys(data.result).find(k => k !== 'last');
        return (data.result[key] || []).map(o => ({
            date: new Date(o[0] * 1000).toISOString(),
            open: +o[1], high: +o[2], low: +o[3], close: +o[4], volume: +o[6]
        }));
    } catch (e) {
        return null;
    }
};

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

async function cycle() {
    try {
        const { KRAKEN_API_KEY, KRAKEN_SECRET_KEY } = process.env;
        if (!KRAKEN_API_KEY || !KRAKEN_SECRET_KEY) {
            log.error('Missing API keys. Please set KRAKEN_API_KEY and KRAKEN_SECRET_KEY in your .env file.');
            return;
        }

        const dataHandler = new DataHandler(KRAKEN_API_KEY, KRAKEN_SECRET_KEY);
        const strat = new StrategyEngine();
        const risk = new RiskManager({ leverage: 10, stopLossMultiplier: 2, takeProfitMultiplier: 3, marginBuffer: 0.4 });
        const exec = new ExecutionHandler(dataHandler.api);

        let allOhlcData = {};
        log.info('Fetching OHLC data for all timeframes...');
        try {
            const fetchPromises = Object.entries(INTERVALS).map(async ([timeframe, interval]) => {
                const candles = await fetchKrakenData({ pair: OHLC_PAIR, interval });
                allOhlcData[timeframe] = candles;
            });
            await Promise.all(fetchPromises);
            log.info('OHLC data for all timeframes has been fetched.');
        } catch (dataError) {
            log.error('Failed to fetch all market data:', dataError);
            return;
        }

        const timeframeDecision = await strat.selectTimeframeAndStrategy(allOhlcData, commit);
        log.info('AI Timeframe Decision:', timeframeDecision);
        const chosenTimeframe = timeframeDecision.timeframe;
        log.info(`AI selected "${chosenTimeframe}" as the most interesting timeframe to trade on.`);
            if (chosenTimeframe === commit.prevTf) TfConsist++;
            else TfConsist = 0;
        commit = {
                prevTf: chosenTimeframe,
                prevR: timeframeDecision.reason,
                prevS: timeframeDecision.strategy,
                tfC: TfConsist
                  };

        // Update the cycle time based on the chosen timeframe
        CYCLE_MS = INTERVALS[chosenTimeframe] * 60 * 1000;
        log.info(`Updated cycle time to ${CYCLE_MS / 1000 / 60} minutes (${CYCLE_MS}ms).`);

        let market;
        try {
            const rawMarketData = await dataHandler.fetchAllData(OHLC_PAIR, INTERVALS[chosenTimeframe]);
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

            let signal;
            try {
                signal = await strat.generateSignal(market, chosenTimeframe, commit);
                log.info('AI Signal Response:', signal);
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
    } finally {
        setTimeout(cycle, CYCLE_MS);
    }
}

startWebServer();
log.info('Bot is starting up...');
cycle();

process.on('SIGINT', () => {
    log.warn('Shutting down gracefully...');
    process.exit(0);
});
