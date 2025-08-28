// executionHandler.js - with enhanced logging
import { log } from './logger.js';

/**
 * @class ExecutionHandler
 * @description Places a trade in two steps: first the entry order, then a minute later, the stop-loss and take-profit orders.
 */
export class ExecutionHandler {
    constructor(api) {
        if (!api) {
            // Use an error log for critical initialization issues
            log.error("ExecutionHandler requires an instance of the KrakenFuturesApi client. Exiting.", new Error("Missing KrakenFuturesApi instance"));
            throw new Error("ExecutionHandler requires an instance of the KrakenFuturesApi client.");
        }
        log.info("ExecutionHandler initialized.");
        this.api = api;
    }

    /**
     * @method placeOrder
     * @description Orchestrates the two-step order placement process.
     * @param {object} tradeDetails The trade parameters.
     * @param {string} tradeDetails.signal 'LONG' or 'SHORT'.
     * @param {string} tradeDetails.pair The trading pair (e.g., 'PI_XBTUSD').
     * @param {object} tradeDetails.params The order parameters.
     * @param {number} tradeDetails.params.size The size of the order.
     * @param {number} tradeDetails.params.stopLoss The stop-loss price.
     * @param {number} tradeDetails.params.takeProfit The take-profit price.
     * @param {number} tradeDetails.lastPrice The last known price of the instrument.
     */
    async placeOrder({ signal, pair, params, lastPrice }) {
        const { size, stopLoss, takeProfit } = params;
        
        // Log the received parameters for debugging
        console.log(`${size} SIZE`);
        log.info('Received trade details for order placement.', { signal, pair, size, stopLoss, takeProfit, lastPrice });

        if (!['LONG', 'SHORT'].includes(signal) || !pair || !size || !stopLoss || !takeProfit || !lastPrice) {
            // Log a specific error for invalid inputs
            log.error("Invalid trade details provided to ExecutionHandler.", new Error("Validation failed for order parameters"));
            throw new Error("Invalid trade details provided to ExecutionHandler, lastPrice is required.");
        }

        const entrySide = (signal === 'LONG') ? 'buy' : 'sell';
        const closeSide = (signal === 'LONG') ? 'sell' : 'buy';

        // Use an aggressive limit price for the entry order to simulate a market order.
        const entrySlippagePercent = 0.001; // 0.1%
        const entryLimitPrice = (signal === 'LONG')
            ? Math.round(lastPrice * (1 + entrySlippagePercent))
            : Math.round(lastPrice * (1 - entrySlippagePercent));

        log.info(`Step 1: Preparing to place entry order for ${size} BTC on ${pair}`);

        try {
            // ----------------------------------------------------
            // Step 1: Send the initial entry order.
            // Using `sendOrder` for a single order, as requested.
            // ----------------------------------------------------
            const entryOrderPayload = {
                orderType: 'lmt',
                symbol: pair,
                side: entrySide,
                size: size,
                limitPrice: entryLimitPrice,
            };

            log.info('Sending entry order to API.', { payload: entryOrderPayload });
            const entryResponse = await this.api.sendOrder(entryOrderPayload);

            if (entryResponse.result === 'success') {
                log.info("✅ Entry order successfully placed. Waiting 60 seconds to place protection orders...");
            } else {
                log.error("❌ Failed to place entry order. Aborting order placement.", { apiResponse: entryResponse });
                return entryResponse; // Abort if the first order fails
            }

            // ----------------------------------------------------
            // Step 2: Wait for 1 minute before placing the next orders.
            // ----------------------------------------------------
            await new Promise(resolve => setTimeout(resolve, 60000));
            log.info("One-minute delay complete. Proceeding with protection orders.");

            // ----------------------------------------------------
            // Step 3: Prepare and send the stop-loss and take-profit orders.
            // ----------------------------------------------------
            const stopSlippagePercent = 0.01; // 1% slippage buffer
            const stopLimitPrice = (closeSide === 'sell')
                ? Math.round(stopLoss * (1 - stopSlippagePercent))
                : Math.round(stopLoss * (1 + stopSlippagePercent));

            const batchOrderPayload = {
                batchOrder: [
                    // The Stop-Loss Order (Stop-Limit)
                    {
                        order: 'send',
                        order_tag: '2',
                        orderType: 'stp',
                        symbol: pair,
                        side: closeSide,
                        size: size,
                        limitPrice: stopLimitPrice,
                        stopPrice: stopLoss,
                        reduceOnly: true
                    },
                    // The Take-Profit Order (Limit Order)
                    {
                        order: 'send',
                        order_tag: '3',
                        orderType: 'lmt',
                        symbol: pair,
                        side: closeSide,
                        size: size,
                        limitPrice: takeProfit,
                        reduceOnly: true
                    }
                ]
            };
            
            log.info(`Sending batch order for stop-loss and take-profit. Payload:`, { payload: batchOrderPayload });

            const protectionResponse = await this.api.batchOrder({ json: JSON.stringify(batchOrderPayload) });
            
            log.info('Protection Orders API Response received.', { response: protectionResponse });

            if (protectionResponse.result === 'success') {
                log.info("✅ Successfully placed protection orders!");
            } else {
                log.error("❌ Failed to place protection orders. API response was not successful.", { apiResponse: protectionResponse });
            }

            return protectionResponse;

        } catch (error) {
            log.error("❌ CRITICAL ERROR in ExecutionHandler during order placement.", error);
            throw error;
        }
    }
}
