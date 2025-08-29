import fs from 'fs';
import path from 'path';

// Define the base log directory and create it if it doesn't exist.
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Define the paths for the human-readable and machine-readable logs.
const humanLog = path.join(logDir, 'trading-bot.log');
const jsonLog = path.join(logDir, 'metrics.ndjson');

/**
 * The core logging method that handles all log levels.
 * It uses a rest parameter `...args` to capture all arguments after `level`.
 *
 * @param {string} level The log level (e.g., 'INFO', 'WARN').
 * @param {...any} args The arguments to be logged.
 */
class Logger {
  _write(level, ...args) {
    const ts = new Date().toISOString();

    // The first argument is the main message.
    const msg = args[0];
    // The rest of the arguments are treated as extra data.
    const extra = args.slice(1);

    // Join all arguments into a single, human-readable string for the console and text log.
    const logMessage = `[${ts}] [${level.padEnd(5)}] ${args.map(arg => {
      return typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg);
    }).join(' ')}`;

    // Log the message to the console and human-readable file.
    console.log(logMessage);
    fs.appendFileSync(humanLog, logMessage + '\n');
    
    // Always log to the JSON log file. This is the fix.
    fs.appendFileSync(
      jsonLog,
      JSON.stringify({ ts, level, msg, extra }) + '\n'
    );
  }

  // Refactored methods to use rest parameters for flexibility.
  info(...args)  { this._write('INFO', ...args); }
  warn(...args)  { this._write('WARN', ...args); }

  error(msg, err) {
    const extra = err ? { error: err.message, stack: err.stack } : {};
    this._write('ERROR', msg, extra);
  }

  metric(metric, value, unit = '', tags = {}) {
    this._write('METRIC', `${metric} = ${value} ${unit}`, { metric, value, unit, ...tags });
  }
}

export const log = new Logger();
