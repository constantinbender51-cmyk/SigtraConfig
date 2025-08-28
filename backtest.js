// backtest.js

// --- FIX: Added import statements ---
import { BacktestRunner } from './backtestRunner.js';
import { ensureDataFileExists } from './dataFetcher.js';
import { log } from './logger.js';

// --- Configuration ---
const config = {
    DATA_FILE_PATH: './data/XBTUSD_3m_data.csv',
    INITIAL_BALANCE: 10000,
    MINIMUM_CONFIDENCE_THRESHOLD: 0,
    MIN_SECONDS_BETWEEN_CALLS: 10,
    MAX_API_CALLS: 20,
    DATA_WINDOW_SIZE: 52,
    WARMUP_PERIOD: 52
};

async function main() {
    try {
        await ensureDataFileExists(config.DATA_FILE_PATH);
        const runner = new BacktestRunner(config);
        await runner.run();
    } catch (error) {
        log.error("A critical error occurred during the backtest process:", error);
    }
}

main();
