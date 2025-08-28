// logger.js (with error stack trace logging)
import fs from 'fs';
import path from 'path';

const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const humanLog = path.join(logDir, 'trading-bot.log');
const jsonLog  = path.join(logDir, 'metrics.ndjson');

class Logger {
  _write(level, msg, extra = {}) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.padEnd(5)}] ${msg}`;
    
    // Log the main message to the console
    console.log(line);
    fs.appendFileSync(humanLog, line + '\n');
    
    // Check if a stack trace is available and log it
    if (extra.stack) {
        const stackLine = `[${ts}] [${level.padEnd(5)}] Stack: ${extra.stack}`;
        console.error(stackLine);
        fs.appendFileSync(humanLog, stackLine + '\n');
    }

    // Always log the full data to the json log file
    if (Object.keys(extra).length) {
      fs.appendFileSync(
        jsonLog,
        JSON.stringify({ ts, level, msg, ...extra }) + '\n'
      );
    }
  }

  info(msg, extra)  { this._write('INFO',  msg, extra); }
  warn(msg, extra)  { this._write('WARN',  msg, extra); }
  error(msg, err)   {
    const extra = err ? { error: err.message, stack: err.stack } : {};
    this._write('ERROR', msg, extra);
  }

  metric(metric, value, unit = '', tags = {}) {
    this._write('METRIC', `${metric} = ${value} ${unit}`, { metric, value, unit, ...tags });
  }
}

export const log = new Logger();
