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
            log.info('Fetching market data...');
            market = await data.fetchAllData(OHLC_PAIR, INTERVAL);
            log.info('Market data fetched successfully.');
        } catch (dataError) {
            log.error('Failed to fetch market data:', dataError.message);
            // Log the full error for debugging
            log.debug('Full data fetch error object:', dataError);
            return; // Skip the rest of the cycle if data fetch fails
        }

        // Validate market data before proceeding
        if (!market || market.balance === undefined || !market.ohlc || !market.ohlc.length) {
            log.warn('Incomplete or invalid market data received. Skipping this cycle.');
            return;
        }

        curBalance = market.balance;
        equity.push(curBalance);
        log.info(`Current balance: ${curBalance} USD`);

        // daily return
        if (lastBalance !== null) {
            returns.push((curBalance - lastBalance) / lastBalance);
            if (returns.length > 30) returns.shift();
            log.info(`Daily return recorded. Returns array length: ${returns.length}`);
        }

        const open = market.positions?.openPositions?.filter(p => p.symbol === PAIR) || [];

        /* position just closed */
        if (!open.length && lastBalance !== null) {
            const pnl = curBalance - firstBalance;
            pnls.push(pnl);
            log.info(`Position closed. Realized PnL: ${pnl} USD`);
            recordStats();
            lastBalance = curBalance; // Update last balance after a PnL record
        }

        /* first flat cycle */
        if (firstBalance === null && !open.length) {
            firstBalance = lastBalance = curBalance;
            log.metric('initial_balance', firstBalance, 'USD');
        }

        /* already in position */
        if (open.length) {
            log.info('Position open; skipping trading logic.');
            return;
        }

        /* generate signal & trade */
        let signal;
        try {
            log.info('Generating trading signal...');
            signal = await strat.generateSignal(market);
            log.metric('signal_cnt', ++sigCnt);
            log.info(`Generated signal: ${signal.signal}, Confidence: ${signal.confidence}`);
        } catch (signalError) {
            log.error('Failed to generate trading signal:', signalError.message);
            log.debug('Full signal generation error object:', signalError);
            return;
        }

        if (signal.signal !== 'HOLD' && signal.confidence >= MIN_CONF) {
            log.info(`Signal meets confidence threshold (${MIN_CONF}). Calculating trade parameters...`);
            const params = risk.calculateTradeParameters(market, signal);

            if (params) {
                log.info('Trade parameters calculated. Attempting to place order...');
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
            log.info(`Signal is 'HOLD' or confidence is too low (${signal.confidence} < ${MIN_CONF}). No trade will be placed.`);
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
