// executionHandler.js

import { log } from './logger.js';

/**
 * @class ExecutionHandler
 * @description Places an entry trade and manages the placement of corresponding exit orders.
 */
export class ExecutionHandler {
    constructor(api) {
        if (!api) {
            throw new Error("ExecutionHandler requires an instance of the KrakenFuturesApi client.");
        }
        this.api = api;
        log.info("ExecutionHandler initialized.");
    }

    /**
     * Places the initial aggressive limit order to enter a position.
     * @param {Object} params - The trading parameters.
     * @param {string} params.signal - 'LONG' or 'SHORT'.
     * @param {string} params.pair - The trading pair symbol.
     * @param {Object} params.params - The risk-managed trade parameters (size, etc.).
     * @param {number} params.lastPrice - The most recent closing price.
     */
    async placeEntryOrder({ signal, pair, params, lastPrice }) {
        const { size } = params;

        if (!['LONG', 'SHORT'].includes(signal) || !pair || !size || !lastPrice) {
            throw new Error("Invalid entry order details provided to ExecutionHandler.");
        }

        const entrySide = (signal === 'LONG') ? 'buy' : 'sell';

        // Use an aggressive limit price for the entry order to simulate a market order.
        const entrySlippagePercent = 0.001; // 0.1%
        const entryLimitPrice = (signal === 'LONG')
            ? Math.round(lastPrice * (1 + entrySlippagePercent))
            : Math.round(lastPrice * (1 - entrySlippagePercent));

        log.info(`Preparing to place ${signal} entry order for ${size} BTC of ${pair} at limit price ${entryLimitPrice}`);

        try {
            // We now ONLY place the main entry order here. Exits are handled separately.
            const response = await this.api.sendOrder({
                orderType: 'lmt',
                symbol: pair,
                side: entrySide,
                size: size,
                limitPrice: entryLimitPrice
            });

            log.info(`Entry Order Response Received: ${JSON.stringify(response, null, 2)}`);

            if (response.result === 'success') {
                log.info("✅ Successfully placed entry order!");
            } else {
                log.error("❌ Failed to place entry order.", response);
            }

            return response;
        } catch (error) {
            log.error("❌ CRITICAL ERROR in ExecutionHandler during entry order placement:", error);
            throw error;
        }
    }

    /**
     * Places the stop-loss and take-profit orders for a filled position.
     * @param {Object} params - The trading parameters.
     * @param {string} params.pair - The trading pair symbol.
     * @param {Object} params.params - The risk-managed trade parameters (size, etc.).
     * @param {number} params.filledSize - The size of the currently filled position.
     */
    async placeExitOrders({ pair, params, filledSize }) {
        const { stopLoss, takeProfit } = params;
        if (!stopLoss || !takeProfit || !filledSize || !pair) {
            throw new Error("Invalid exit order details provided to ExecutionHandler.");
        }

        const closeSide = (filledSize > 0) ? 'sell' : 'buy';

        // Create a stop-limit order for the stop-loss.
        const stopSlippagePercent = 0.01; // 1% slippage buffer
        const stopLimitPrice = (closeSide === 'sell')
            ? Math.round(stopLoss * (1 - stopSlippagePercent))
            : Math.round(stopLoss * (1 + stopSlippagePercent));

        log.info(`Preparing to place exit orders for position size: ${filledSize}`);

        try {
            const batchOrderPayload = {
                batchOrder: [
                    // The Stop-Loss Order (Stop-Limit)
                    {
                        order: 'send',
                        orderType: 'stp',
                        symbol: pair,
                        side: closeSide,
                        size: Math.abs(filledSize),
                        limitPrice: stopLimitPrice,
                        stopPrice: stopLoss,
                        reduceOnly: true
                    },
                    // The Take-Profit Order (Limit Order)
                    {
                        order: 'send',
                        orderType: 'lmt',
                        symbol: pair,
                        side: closeSide,
                        size: Math.abs(filledSize),
                        limitPrice: takeProfit,
                        reduceOnly: true
                    }
                ]
            };

            log.info(`Placing Batch Exit Orders: ${JSON.stringify(batchOrderPayload, null, 2)}`);

            const response = await this.api.batchOrder({ json: JSON.stringify(batchOrderPayload) });

            log.info(`Batch Exit Order Response Received: ${JSON.stringify(response, null, 2)}`);

            if (response.result === 'success') {
                log.info("✅ Successfully placed batch exit orders!");
            } else {
                log.error("❌ Failed to place batch exit orders.", response);
            }
            return response;
        } catch (error) {
            log.error("❌ CRITICAL ERROR in ExecutionHandler during exit order placement:", error);
            throw error;
        }
    }
}
