// logger.js (with corrected logging and stack trace)
import fs from 'fs';
import path from 'path';

// Define the base log directory and create it if it doesn't exist.
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

// Define the paths for the human-readable and machine-readable logs.
const humanLog = path.join(logDir, 'trading-bot.log');
const jsonLog = path.join(logDir, 'metrics.ndjson');

/**
 * The core logging method that handles all log levels.
 * It uses a rest parameter `...args` to capture all arguments after `level`.
 * This allows for flexible logging of strings, numbers, objects, etc.
 *
 * @param {string} level The log level (e.g., 'INFO', 'WARN').
 * @param {...any} args The arguments to be logged.
 */
class Logger {
  _write(level, ...args) {
    const ts = new Date().toISOString();

    // The first argument is the main message.
    // The rest of the arguments are treated as extra data.
    const msg = args[0];
    const extra = args.slice(1);

    // Join all arguments into a single, human-readable string for the console and text log.
    // Objects are automatically converted to a readable format by `console.log`.
    const logMessage = `[${ts}] [${level.padEnd(5)}] ${args.map(arg => {
      // For objects, use JSON.stringify for a consistent text log output.
      return typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg);
    }).join(' ')}`;

    // Log the message to the console.
    console.log(logMessage);
    fs.appendFileSync(humanLog, logMessage + '\n');
    
    // Always log the full data to the json log file.
    // This includes the main message and any additional objects.
    if (extra.length > 0) {
      fs.appendFileSync(
        jsonLog,
        JSON.stringify({ ts, level, msg, extra }) + '\n'
      );
    }
  }

  // Refactored methods to use rest parameters for flexibility.
  info(...args)  { this._write('INFO', ...args); }
  warn(...args)  { this._write('WARN', ...args); }

  error(msg, err) {
    const extra = err ? { error: err.message, stack: err.stack } : {};
    this._write('ERROR', msg, extra);
  }

  metric(metric, value, unit = '', tags = {}) {
    // This method is a specific case, so its signature is kept.
    this._write('METRIC', `${metric} = ${value} ${unit}`, { metric, value, unit, ...tags });
  }
}

export const log = new Logger();

// Example Usage:
// log.info('info message with number:', 1 + 2);
// log.warn('A warning with a complex object:', { a: 1, b: 'two' });
// try {
//   throw new Error('Something went wrong!');
// } catch (err) {
//   log.error('An error occurred during a trade:', err);
// }
