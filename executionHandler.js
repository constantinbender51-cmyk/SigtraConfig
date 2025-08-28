// executionHandler.js - with enhanced logging
import { log } from './logger.js';

/**
 * @class ExecutionHandler
 * @description Places a trade using an aggressive limit order for entry and a stop-limit for protection.
 */
export class ExecutionHandler {
    constructor(api) {
        if (!api) {
            // Use an error log for critical initialization issues
            log.error("ExecutionHandler requires an instance of the KrakenFuturesApi client. Exiting.", new Error("Missing KrakenFuturesApi instance"));
            throw new Error("ExecutionHandler requires an instance of the KrakenFuturesApi client.");
        }
        log.info("ExecutionHandler initialized.");
    }

    async placeOrder({ signal, pair, params, lastPrice }) {
        const { size, stopLoss, takeProfit } = params;
        
        // Log the received parameters for debugging
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

        // Create a stop-limit order for the stop-loss.
        const stopSlippagePercent = 0.01; // 1% slippage buffer
        const stopLimitPrice = (closeSide === 'sell')
            ? Math.round(stopLoss * (1 - stopSlippagePercent))
            : Math.round(stopLoss * (1 + stopSlippagePercent));

        log.info(`Preparing to place ${signal} order for ${size} BTC on ${pair}`);

        try {
            const batchOrderPayload = {
                batchOrder: [
                    // 1. The Main Entry Order (Aggressive Limit)
                    {
                        order: 'send',
                        order_tag: '1',
                        orderType: 'lmt',
                        symbol: pair,
                        side: entrySide,
                        size: size,
                        limitPrice: entryLimitPrice,
                    },
                    // 2. The Stop-Loss Order (Stop-Limit)
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
                    // 3. The Take-Profit Order (Limit Order)
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

            // Log the full payload before sending to the API
            log.info(`Sending batch order to API. Payload:`, { payload: batchOrderPayload });

            const response = await this.api.batchOrder({ json: JSON.stringify(batchOrderPayload) });
            
            // Log the raw response from the API
            log.info('Batch Order API Response received.', { response });

            if (response.result === 'success') {
                log.info("✅ Successfully placed batch order!");
            } else {
                // Log the failure reason from the API response
                log.error("❌ Failed to place batch order. API response was not successful.", { apiResponse: response });
            }

            return response;

        } catch (error) {
            // Use the error logging method to capture the stack trace
            log.error("❌ CRITICAL ERROR in ExecutionHandler during order placement.", error);
            throw error;
        }
    }
}
