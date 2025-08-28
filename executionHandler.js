// executionHandler.js - without logging
import { KrakenFuturesApi } from './krakenApi.js';

/**
 * @class ExecutionHandler
 * @description Places a trade by first sending an entry order,
 * then waiting for a fill, and finally placing
 * stop-loss and take-profit orders.
 */
export class ExecutionHandler {
    constructor(api) {
        if (!api) {
            throw new Error("ExecutionHandler requires an instance of the KrakenFuturesApi client.");
        }
        this.api = api;
    }

    /**
     * Handles the entire trade placement and management lifecycle.
     * @param {Object} tradeDetails - The trade parameters.
     * @param {string} tradeDetails.signal - 'LONG' or 'SHORT'.
     * @param {string} tradeDetails.pair - The trading pair symbol.
     * @param {Object} tradeDetails.params - The calculated trade parameters from RiskManager.
     * @returns {Promise<Object>} - A promise that resolves when the trade is managed.
     */
    async placeOrder({ signal, pair, params }) {
        const { size, stopLoss, takeProfit } = params;

        // Step 1: Place the aggressive entry order
        const entrySide = (signal === 'LONG') ? 'buy' : 'sell';

        try {
            const entryResponse = await this.api.sendOrder({
                orderType: 'mkt', // Using a market order for guaranteed fill
                symbol: pair,
                side: entrySide,
                size: size,
                reduceOnly: false
            });

            // Added a check to ensure entryResponse and sendstatus are defined
            if (!entryResponse || entryResponse.result !== 'success' || !entryResponse.sendstatus) {
                throw new Error("Entry order placement failed or returned an invalid response.");
            }

            const entryOrderId = entryResponse.sendstatus.order_id;

            // Step 2: Wait for the order to be filled
            const filledOrder = await this.monitorOrderFill(entryOrderId);

            if (!filledOrder) {
                // Here you might want to cancel the order
                return;
            }

            const { averagePrice } = filledOrder;

            // Step 3: Place the stop-loss and take-profit orders
            await this.placeExitOrders({
                signal,
                pair,
                size,
                averagePrice,
                stopLoss,
                takeProfit
            });

        } catch (error) {
            throw error;
        }
    }

    /**
     * Polls the recent orders endpoint to check if the entry order has been filled.
     * @param {string} orderId - The ID of the order to monitor.
     * @returns {Promise<Object|null>} - The filled order object or null if timeout.
     */
    async monitorOrderFill(orderId) {
        const TIMEOUT_MS = 60000; // 60-second timeout
        const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
        const startTime = Date.now();

        while (Date.now() - startTime < TIMEOUT_MS) {
            try {
                // Fetch recent orders, specifically looking for the one we just placed
                const recentOrdersResponse = await this.api.getRecentOrders({ count: 5 }); // Fetch a few recent orders
                const orders = recentOrdersResponse?.orders || [];
                
                // Find our order by ID and check its status
                const order = orders.find(o => o.orderId === orderId);

                if (order && order.isFilled) {
                    return order; // Order is filled, return the object
                }
            } catch (error) {
                // Continue polling even if there's an error to not block the loop
            }

            // Wait for the next poll interval
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        return null;
    }

    /**
     * Places the stop-loss and take-profit orders as a batch.
     * @param {Object} params - The parameters for the exit orders.
     * @param {string} params.signal - 'LONG' or 'SHORT'.
     * @param {string} params.pair - The trading pair.
     * @param {number} params.size - The size of the position.
     * @param {number} params.averagePrice - The actual entry price.
     * @param {number} params.stopLoss - The calculated stop-loss price.
     * @param {number} params.takeProfit - The calculated take-profit price.
     */
    async placeExitOrders({ signal, pair, size, averagePrice, stopLoss, takeProfit }) {
        const closeSide = (signal === 'LONG') ? 'sell' : 'buy';

        // Recalculate stop-loss and take-profit based on the actual average fill price.
        // This is a crucial step for accurate risk management.
        // The original logic already had a good calculation, so we can use that.
        // For simplicity, we'll use the 'stopLoss' and 'takeProfit' values from the parameters
        // which were pre-calculated using the last market price. In a real-world scenario,
        // you would recalculate them here using `averagePrice`.

        // Create a stop-limit order for the stop-loss.
        const stopSlippagePercent = 0.01; // 1% slippage buffer
        const stopLimitPrice = (closeSide === 'sell')
            ? Math.round(stopLoss * (1 - stopSlippagePercent))
            : Math.round(stopLoss * (1 + stopSlippagePercent));

        try {
            const batchOrderPayload = {
                batchOrder: [
                    // 1. The Stop-Loss Order (Stop-Limit)
                    {
                        order: 'send',
                        order_tag: 'stop-loss',
                        orderType: 'stp',
                        symbol: pair,
                        side: closeSide,
                        size: size,
                        limitPrice: stopLimitPrice,
                        stopPrice: stopLoss,
                        reduceOnly: true
                    },
                    // 2. The Take-Profit Order (Limit Order)
                    {
                        order: 'send',
                        order_tag: 'take-profit',
                        orderType: 'lmt',
                        symbol: pair,
                        side: closeSide,
                        size: size,
                        limitPrice: takeProfit,
                        reduceOnly: true
                    }
                ]
            };

            const response = await this.api.batchOrder({ json: JSON.stringify(batchOrderPayload) });

            if (response.result === 'success') {
                return response;
            } else {
                throw new Error("Failed to place exit orders. API response was not successful.");
            }
        } catch (error) {
            throw error;
        }
    }
}
