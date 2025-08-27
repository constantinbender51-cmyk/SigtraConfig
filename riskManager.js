// riskManager.js

import { log } from './logger.js';

export class RiskManager {
    constructor(config) {
        this.leverage = config.leverage || 10;
        this.marginBuffer = config.marginBuffer || 0.01;
    }

    /**
     * Calculates the position size based on the AI's trade plan.
     * The AI now provides the stop-loss and take-profit distances.
     * This version adds a safeguard to prevent oversized positions from tight stop-losses.
     * @param {object} marketData - Contains balance and last price.
     * @param {object} tradingSignal - The full trade plan from the AI.
     * @returns {object|null} The final trade parameters, or null if risk is invalid.
     */
    calculateTradeParameters(marketData, tradingSignal) {
        const { balance, ohlc } = marketData;
        const lastPrice = ohlc[ohlc.length - 1].close;

        if (!balance || balance <= 0) {
            log.error('[RISK] Invalid account balance.');
            return null;
        }

        const { stop_loss_distance_in_usd, take_profit_distance_in_usd } = tradingSignal;

        if (!stop_loss_distance_in_usd || stop_loss_distance_in_usd <= 0) {
            log.warn('[RISK] AI provided an invalid stop-loss distance. Aborting trade.');
            return null;
        }
        if (!take_profit_distance_in_usd || take_profit_distance_in_usd <= 0) {
            log.warn('[RISK] AI provided an invalid take-profit distance. Aborting trade.');
            return null;
        }

        // --- Step 1: Calculate Position Sizing based on 2% risk ---
        const riskPerUnit = stop_loss_distance_in_usd;
        const totalCapitalToRisk = balance * 0.02;
        let sizeInUnits = totalCapitalToRisk / riskPerUnit;

        // --- Step 2: NEW! Calculate a safety cap based on available margin ---
        // This prevents the position from being too large for the account.
        // It now includes a 5% buffer to avoid rejections at maximum size.
        const maxSizeBasedOnMargin = ((balance * this.leverage) / lastPrice) * 0.95;

        // --- Step 3: Use the smaller of the two calculated sizes ---
        // This ensures we never risk more than 2% AND never take a position we can't afford.
        sizeInUnits = Math.min(sizeInUnits, maxSizeBasedOnMargin);

        // --- Final Safety Checks ---
        const positionValueUSD = sizeInUnits * lastPrice;
        const marginRequired = (positionValueUSD / this.leverage) * (1 + this.marginBuffer);

        if (marginRequired > balance) {
            // This check should now almost never fail, but it's good practice to keep.
            log.warn(`[RISK] Insufficient funds. Required: $${marginRequired.toFixed(2)}, Available: $${balance.toFixed(2)}`);
            return null;
        }
        if (sizeInUnits < 0.0001) {
            log.warn(`[FAIL] Size is too small: ${sizeInUnits.toFixed(4)}. Aborting trade.`);
            return null;
        }

        const stopLossPrice = tradingSignal.signal === 'LONG' ? lastPrice - stop_loss_distance_in_usd : lastPrice + stop_loss_distance_in_usd;
        const takeProfitPrice = tradingSignal.signal === 'LONG' ? lastPrice + take_profit_distance_in_usd : lastPrice - take_profit_distance_in_usd;

        const tradeParams = {
            size: parseFloat(sizeInUnits.toFixed(4)),
            stopLoss: parseFloat(stopLossPrice.toFixed(0)),
            takeProfit: parseFloat(takeProfitPrice.toFixed(0)),
        };

        log.info(`[RISK] Final Trade Params: ${JSON.stringify(tradeParams, null, 2)}`);

        return tradeParams;
    }
}
