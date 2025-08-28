// backtestRunner.js – cleaned, with added logs
import fs from 'fs';
import { log } from './logger.js';
import { BacktestDataHandler } from './backtestDataHandler.js';
import { StrategyEngine } from './strategyEngine.js';
import { RiskManager } from './riskManager.js';
import { BacktestExecutionHandler } from './backtestExecutionHandler.js';

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */
function tsFromDate(dateStr) {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

function filterByDate(candles, start, end) {
  const startTs = tsFromDate(start);
  const endTs   = tsFromDate(end);
  return candles.filter(c => c.timestamp >= startTs && c.timestamp < endTs);
}

/* ------------------------------------------------------------------ */
/* BacktestRunner                                                     */
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
    log('INFO', 'Starting backtest...');
    
    let candles = this.data.getAllCandles();
    
    const startDate = '2025-07-02';
    const endDate = '2025-08-01';
    candles = filterByDate(candles, startDate, endDate);
    
    if (!candles || candles.length < this.cfg.WARMUP_PERIOD) {
      log('ERROR', 'Not enough data for the warm-up period. Please check your data file and date range.');
      throw new Error('Not enough data for the warm-up period.');
    }

    log('INFO', `Successfully loaded ${candles.length} candles from ${startDate} to ${endDate}.`);
    log('INFO', `Starting simulation loop. Warm-up period: ${this.cfg.WARMUP_PERIOD} candles.`);

    let apiCalls = 0;

    for (let i = this.cfg.WARMUP_PERIOD; i < candles.length; i++) {
      const candle = candles[i];
      const window = candles.slice(i - this.cfg.DATA_WINDOW_SIZE, i);

      // Check for an open trade and try to exit
      if (this.exec.getOpenTrade()) {
        this._checkExit(candle);
      }

      // Check if a new signal should be generated
      if (!this.exec.getOpenTrade()) {
        if (apiCalls >= this.cfg.MAX_API_CALLS) {
          log('WARNING', `Maximum API calls (${this.cfg.MAX_API_CALLS}) reached. Backtest stopping early.`);
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
      if (candle.low  <= t.stopLoss)  { exitPrice = t.stopLoss; exitReason = 'Stop-Loss'; }
      if (candle.high >= t.takeProfit) { exitPrice = t.takeProfit; exitReason = 'Take-Profit'; }
    } else if (t.signal === 'SHORT') {
      if (candle.high >= t.stopLoss)  { exitPrice = t.stopLoss; exitReason = 'Stop-Loss'; }
      if (candle.low  <= t.takeProfit) { exitPrice = t.takeProfit; exitReason = 'Take-Profit'; }
    }

    if (exitPrice) {
      log('INFO', `[TRADE CLOSED] Signal: ${t.signal}, Entry: ${t.entryPrice.toFixed(2)}, Exit: ${exitPrice.toFixed(2)}, Reason: ${exitReason}`);
      this.exec.closeTrade(t, exitPrice, candle.timestamp);
      const updated = this.exec.getTrades();
      fs.writeFileSync('./trades.json', JSON.stringify(updated, null, 2));
    }
  }

  // NOTE: This function is currently bypassed in the run() loop
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
    log('DEBUG', `[API Call ${apiCalls}] Requesting signal...`);
    const t0 = Date.now();
    const sig = await this.strat.generateSignal(market);

    if (sig.signal !== 'HOLD' && sig.confidence >= this.cfg.MINIMUM_CONFIDENCE_THRESHOLD) {
      log('INFO', `[SIGNAL GENERATED] Signal: ${sig.signal}, Confidence: ${sig.confidence.toFixed(2)}, Reason: ${sig.reason}`);
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
        log('INFO', `[TRADE PLACED] Signal: ${sig.signal}, Entry Price: ${candle.close.toFixed(2)}, Stop-Loss: ${params.stopLoss.toFixed(2)}, Take-Profit: ${params.takeProfit.toFixed(2)}`);
      } else {
        log('WARNING', `[TRADE BLOCKED] Signal: ${sig.signal}, but calculated size was too small.`);
      }
    } else {
      log('DEBUG', `[SIGNAL REJECTED] Signal: ${sig.signal}, Confidence: ${sig.confidence.toFixed(2)} (below threshold of ${this.cfg.MINIMUM_CONFIDENCE_THRESHOLD})`);
    }

    const elapsed = Date.now() - t0;
    const delay   = this.cfg.MIN_SECONDS_BETWEEN_CALLS * 1000 - elapsed;
    if (delay > 0) {
      log('DEBUG', `Delaying for ${delay}ms to respect API call frequency.`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  _printSummary(apiCalls) {
    log('INFO', 'Backtest finished.');
    const trades = this.exec.getTrades();
    const totalTrades = trades.length;
    const winningTrades = trades.filter(t => t.pnl > 0).length;
    const losingTrades = totalTrades - winningTrades;
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

    log('INFO', `--- Backtest Summary ---`);
    log('INFO', `Initial Balance: $${this.cfg.INITIAL_BALANCE.toFixed(2)}`);
    log('INFO', `Final Balance:   $${this.exec.balance.toFixed(2)}`);
    log('INFO', `Total P/L:       $${totalPnl.toFixed(2)}`);
    log('INFO', `Trades Executed: ${totalTrades}`);
    log('INFO', `Winning Trades:  ${winningTrades}`);
    log('INFO', `Losing Trades:   ${losingTrades}`);
    log('INFO', `API Calls Made:  ${apiCalls}`);
    log('INFO', `-------------------------`);

    fs.writeFileSync('./trades.json', JSON.stringify(trades, null, 2));
  }
}
