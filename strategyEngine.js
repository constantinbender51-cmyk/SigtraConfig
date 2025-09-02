import fs from 'fs';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { log } from './logger.js';

const BOT_START_TIME = new Date().toISOString();

const readLast10ClosedTradesFromFile = () => {
    try {
        return JSON.parse(fs.readFileSync('./trades.json', 'utf8'))
            .filter(t => t.exitTime)
            .slice(-10);
    } catch {
        return [];
    }
};

function buildLast10ClosedFromRawFills(rawFills, n = 10) {
    if (!Array.isArray(rawFills) || rawFills.length === 0) return [];

    const eligible = rawFills.filter(
        f => new Date(f.fillTime) >= new Date(BOT_START_TIME)
    );
    if (eligible.length === 0) return [];

    const fills = [...eligible].reverse();
    const queue = [];
    const closed = [];

    for (const f of fills) {
        const side = f.side === 'buy' ? 'LONG' : 'SHORT';
        if (!queue.length || queue.at(-1).side === side) {
            queue.push({ side, entryTime: f.fillTime, entryPrice: f.price, size: f.size });
            continue;
        }

        let remaining = f.size;
        while (remaining > 0 && queue.length && queue[0].side !== side) {
            const open = queue.shift();
            const match = Math.min(remaining, open.size);
            const pnl = (f.price - open.entryPrice) * match * (open.side === 'LONG' ? 1 : -1);
            closed.push({
                side: open.side,
                entryTime: open.entryTime,
                entryPrice: open.entryPrice,
                exitTime: f.fillTime,
                exitPrice: f.price,
                size: match,
                pnl
            });
            remaining -= match;
            open.size -= match;
            if (open.size > 0) queue.unshift(open);
        }

        if (remaining > 0) {
            queue.push({ side, entryTime: f.fillTime, entryPrice: f.price, size: remaining });
        }
    }

    const last10 = closed.slice(-n).reverse();
    return last10;
}

export class StrategyEngine {
    constructor() {
        if (!process.env.GEMINI_API_KEY) {
            log.error('GEMINI_API_KEY environment variable is not set.');
            throw new Error('API key missing');
        }
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const safety = [{ category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }];
        this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite', safetySettings: safety });
    }

    async _callWithRetry(prompt, max = 4) {
        for (let i = 1; i <= max; i++) {
            try {
                const res = await this.model.generateContent(prompt);
                const text = res.response.text?.();
                if (!text?.length) throw new Error('Empty response');
                return { ok: true, text };
            } catch (err) {
                log.error(`API Call failed on retry ${i} of ${max}`, err);
                if (i === max) {
                    return { ok: false, error: err };
                }
                await new Promise(r => setTimeout(r, 61_000));
            }
        }
    }

    async selectTimeframe(allOhlcData) {
        const prompt = `Based on the OHLC data provided, select a timeframe for a trading bot to trade on.
Respond with a JSON object containing "reason" and "timeframe".
The timeframe must be one of the following: '1 hour', '4 hour', '1 day', '1 week'.
Do not include any other text.

OHLC Data for all timeframes:
${JSON.stringify(allOhlcData, null, 2)}
`;

        log.info('Calling Gemini to select timeframe...');
        const { ok, text, error } = await this._callWithRetry(prompt);

        if (!ok) {
            log.error('Failed to get timeframe decision from AI. Defaulting to 1 day.');
            return { timeframe: '1 day', reason: 'AI failed to respond.' };
        }

        try {
            // Find and extract the JSON object from the text
            const jsonMatch = text.match(/\{.*\}/s)?.[0];
            if (!jsonMatch) {
                log.error('Could not find a valid JSON object in the AI response. Returning default timeframe.');
                return { timeframe: '1 day', reason: 'AI response malformed.' };
            }
            const decision = JSON.parse(jsonMatch);
            if (decision.timeframe && decision.reason) {
                return decision;
            } else {
                log.error('AI response for timeframe selection was not in the expected format. Defaulting to 1 day.');
                return { timeframe: '1 day', reason: 'AI response malformed.' };
            }
        } catch (e) {
            log.error(`Failed to parse AI response as JSON for timeframe selection. Raw text: "${text}". Error: ${e.message}`);
            return { timeframe: '1 day', reason: 'AI response malformed.' };
        }
    }

    _prompt(market, timeframe) {
        // Limit OHLC data to the last 52 candles for the prompt
        const ohlc = market.ohlc.slice(-52);
        const closes = ohlc.map(c => c.close);
        const latest = closes.at(-1);
        const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const atr14 = (() => {
            const trs = [];
            for (let i = 1; i < 15; i++) {
                const h = ohlc.at(-i).high;
                const l = ohlc.at(-i).low;
                const pc = ohlc.at(-i - 1)?.close ?? h;
                trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
            }
            return trs.reduce((a, b) => a + b, 0) / 14;
        })();

        const momPct = ((latest - sma20) / sma20 * 100).toFixed(2);
        const volPct = (atr14 / latest * 100).toFixed(2);

        const last10 = market.fills?.fills
            ? buildLast10ClosedFromRawFills(market.fills.fills, 10)
            : readLast10ClosedTradesFromFile();
        
        // Log last10 for debugging as requested
        log.info('Logging last10 closed trades for debugging:', JSON.stringify(last10));

        return `Based on the ${timeframe} Timeframe OHLC data, and the indicators below generate a signal json object including "signal" which is LONG SHORT or HOLD,"confidence" a value measuring calculated confluence between 0 and 10,"stop_loss_distance_in_usd" the distance from the current market price a stop loss order is to be initiated,"take_profit_distance_in_usd" the distance a take profit order is to be initiated, and"reason": a comprehensive explanation of your decisionmaking process

OHLC Data for ${timeframe}: ${JSON.stringify(ohlc)}
Indicators:
- lastClose=${latest}
- 20SMA=${sma20.toFixed(2)}
- momentum=${momPct}%
- 14ATR=${volPct}%
- last10Trades=${JSON.stringify(last10)}
`;
    }

    async generateSignal(marketData, timeframe) {
        if (!marketData?.ohlc?.length) {
            log.error('Received an empty or invalid marketData object.');
            return this._fail('No OHLC');
        }

        const prompt = this._prompt(marketData, timeframe);
        log.info(`Calling Gemini to generate signal for ${timeframe}...`);
        const { ok, text, error } = await this._callWithRetry(prompt);

        if (!ok) {
            log.error('API Call Failed. Returning default signal.', error);
            return this._fail('API Error');
        }

        try {
            // Find and extract the JSON object from the text
            const jsonMatch = text.match(/\{.*\}/s)?.[0];
            if (!jsonMatch) {
                log.error('Could not find a valid JSON object in the API response. Returning default signal.');
                return this._fail('Parse error');
            }
            const signal = JSON.parse(jsonMatch);
            return signal;
        } catch (e) {
            log.error(`Failed to parse API response as JSON. Raw text: "${text}". Error: ${e.message}`);
            return this._fail('Parse error');
        }
    }

    _fail(reason) {
        return { signal: 'HOLD', confidence: 0, stop_loss_distance_in_usd: 0, take_profit_distance_in_usd: 0, reason };
    }
}
