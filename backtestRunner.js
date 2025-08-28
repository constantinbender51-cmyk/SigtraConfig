// backtestRunner.js  –  cleaned, no AI post-backtest analysis
import fs from 'fs';
import { log } from './logger.js';
import { BacktestDataHandler } from './backtestDataHandler.js';
import { StrategyEngine } from './strategyEngine.js';
import { RiskManager } from './riskManager.js';
import { BacktestExecutionHandler } from './backtestExecutionHandler.js';

/* ------------------------------------------------------------------ */
/* Utilities                                                         */
/* ------------------------------------------------------------------ */
function tsFromDate(dateStr) {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

function filterByDate(candles, start, end) {
  const startTs = tsFromDate(start);
  const endTs   = tsFromDate(end);
  return candles.filter(c => c.timestamp >= startTs && c.timestamp < endTs);
}

function calculateATR(ohlc, period = 14) {
  const tr = [];
  for (let i = 1; i < ohlc.length; i++) {
    const h  = ohlc[i].high;
    const l  = ohlc[i].low;
    const pc = ohlc[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atrWindow = tr.slice(-period);
  return atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length;
}

/* ------------------------------------------------------------------ */
/* BacktestRunner                                                    */
/* ------------------------------------------------------------------ */
export class BacktestRunner {
  constructor(cfg) {
    this.cfg   = cfg;
    this.data  = new BacktestDataHandler(cfg.DATA_FILE_PATH);
    this.exec  = new BacktestExecutionHandler(cfg.INITIAL_BALANCE);
    this.strat = new StrategyEngine();
    this.risk  = new RiskManager({ leverage: 10, marginBuffer: 0.01 });
  }

  async run() {
    let candles = this.data.getAllCandles();
    candles = filterByDate(candles, '2025-07-02', '2025-08-01');
    if (!candles || candles.length < this.cfg.WARMUP_PERIOD) {
      throw new Error('Not enough data for the warm-up period.');
    }

    let apiCalls = 0;

    for (let i = this.cfg.WARMUP_PERIOD; i < candles.length; i++) {
      const candle = candles[i];
      const window = candles.slice(i - this.cfg.DATA_WINDOW_SIZE, i);

      if (this.exec.getOpenTrade()) this._checkExit(candle);

      if (!this.exec.getOpenTrade()) { // && this._hasSignal({ ohlc: window })) {
        if (apiCalls >= this.cfg.MAX_API_CALLS) {
          break;
        }
        apiCalls++;
        await this._handleSignal({ ohlc: window }, candle, apiCalls);
      }
    }
    this._printSummary(apiCalls);
  }

  /* ------------------------ Private ------------------------ */
  _checkExit(candle) {
    const t = this.exec.getOpenTrade();
    let exitPrice  = null;
    let exitReason = '';

    if (t.signal === 'LONG') {
      if (candle.low  <= t.stopLoss)   { exitPrice = t.stopLoss; exitReason = 'Stop-Loss'; }
      if (candle.high >= t.takeProfit) { exitPrice = t.takeProfit; exitReason = 'Take-Profit'; }
    } else if (t.signal === 'SHORT') {
      if (candle.high >= t.stopLoss)   { exitPrice = t.stopLoss; exitReason = 'Stop-Loss'; }
      if (candle.low  <= t.takeProfit) { exitPrice = t.takeProfit; exitReason = 'Take-Profit'; }
    }

    if (exitPrice) {
      this.exec.closeTrade(t, exitPrice, candle.timestamp);
      const updated = this.exec.getTrades();
      fs.writeFileSync('./trades.json', JSON.stringify(updated, null, 2));
    }
  }

  _hasSignal(market) {
    const PERIOD = 21;
    if (market.ohlc.length < PERIOD + 1) return false;
    const cur   = market.ohlc[market.ohlc.length - 1];
    const prev  = market.ohlc.slice(-PERIOD - 1, -1);
    const hh  = Math.max(...prev.map(c => c.high));
    const ll  = Math.min(...prev.map(c => c.low));
    const mid = (hh + ll) / 2;
    const buffer  = cur.close * 0.0015;
    const bullish = cur.high > mid + buffer;
    const bearish = cur.low  < mid - buffer;
    return true;// bullish || bearish;
  }

  async _handleSignal(market, candle, apiCalls) {
    const t0 = Date.now();
    const sig = await this.strat.generateSignal(market);
    if (sig.signal !== 'HOLD' && sig.confidence >= this.cfg.MINIMUM_CONFIDENCE_THRESHOLD) {
      const params = this.risk.calculateTradeParameters(
        { ...market, balance: this.exec.balance },
        sig
      );
      if (params?.size > 0) {
        this.exec.placeOrder({
          signal: sig.signal,
          params,
          entryPrice: candle.close,
          entryTime: candle.timestamp,
          reason: sig.reason
        });
      }
    }
    const elapsed = Date.now() - t0;
    const delay   = this.cfg.MIN_SECONDS_BETWEEN_CALLS * 1000 - elapsed;
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
  }

  _printSummary(apiCalls) {
    const trades   = this.exec.getTrades();
    fs.writeFileSync('./trades.json', JSON.stringify(trades, null, 2));
  }
}
