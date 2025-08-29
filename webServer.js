// webServer.js
import express from 'express';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 3000;
const metricsFile = path.join(process.cwd(), 'logs', 'metrics.ndjson');
const humanLog    = path.join(process.cwd(), 'logs', 'trading-bot.log');

// ----------------------------------------
// Shared CSS (white & sleek)
// ----------------------------------------
const css = `
  * { margin:0; padding:0; box-sizing:border-box }
  html { font-size:16px }
  body {
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    color:#212529; background:#ffffff; line-height:1.6; padding:1rem; min-height:100vh;
  }
  h1 { margin-bottom:1rem; font-weight:600; color:#0f62fe; font-size:1.75rem }
  a.btn {
    display:inline-block; margin:.25rem .5rem .75rem 0; padding:.9rem 1.6rem;
    border-radius:8px; background:#0f62fe; color:#fff;
    text-decoration:none; font-size:1.1rem; font-weight:500; min-width:12rem; text-align:center;
  }
  table {
    width:100%; border-collapse:collapse; box-shadow:0 1px 4px rgba(0,0,0,.08);
    border-radius:8px; overflow:hidden;
  }
  th,td { padding:1rem; border-bottom:1px solid #e5e5e5; font-size:1.1rem }
  th { font-weight:600; background:#f8f9fa }
  pre {
    background:#f8f9fa; border:1px solid #e5e5e5; border-radius:8px;
    padding:1rem; font-size:1rem; white-space:pre-wrap; word-break:break-all
  }
  .subtitle { color:#666; margin-top:1rem }
  @media (max-width:600px) {
    body { padding:.75rem }
    h1   { font-size:1.5rem }
    table th,td { padding:.75rem .5rem; font-size:1rem }
  }
`;

// ----------------------------------------
// Helper: build latest metric map
// ----------------------------------------
function getLatestMetrics() {
  let metrics = [];
  if (fs.existsSync(metricsFile)) {
    metrics = fs.readFileSync(metricsFile, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map(JSON.parse);
  }
  const latest = {};
  metrics.forEach(m => { if (m.metric) latest[m.metric] = { value: m.value, unit: m.unit || '' }; });
  return latest;
}

// ----------------------------------------
// Express setup
// ----------------------------------------
export function startWebServer() {
  const app = express();

  // ---------- MAIN PAGE ----------
  app.get('/', (req, res) => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <title>SigtraConfig</title>
        <style>
          body {
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background-color: #f0f2f5;
            color: #333;
            margin: 0;
          }
          .container {
            text-align: center;
            padding: 2rem;
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
          }
          h1 {
            font-size: 2.5rem;
            font-weight: 700;
            color: #007bff;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>SigtraConfig</h1>
        </div>
      </body>
      </html>`;
    res.send(html);
  });

  // ---------- DEEP DIVE ----------
  app.get('/deep', (req, res) => {
    const latest = getLatestMetrics();
    const rows = Object.entries(latest)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `<tr><td>${k}</td><td>${v.value} ${v.unit}</td></tr>`)
      .join('');

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <title>Deep Dive – All Metrics</title>
        <meta http-equiv="refresh" content="30">
        <style>${css}</style>
      </head>
      <body>
        <h1>Deep Dive – All Metrics</h1>
        <a class="btn" href="/">📊 Home</a>
        <a class="btn" href="/logs">📄 Raw Logs</a>
        <table>
          <tr><th>Metric</th><th>Value</th></tr>
          ${rows}
        </table>
        <p class="subtitle">Last updated: ${new Date().toLocaleTimeString()}</p>
      </body>
      </html>`;
    res.send(html);
  });

  // ---------- RAW LOGS ----------
  app.get('/logs', (req, res) => {
    fs.readFile(humanLog, 'utf8', (err, data) => {
      if (err) return res.status(500).send('Cannot read log file.');
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8"/>
          <title>Trading Bot Logs</title>
          <meta http-equiv="refresh" content="30">
          <style>${css}</style>
        </head>
        <body>
          <h1>Trading Bot Logs</h1>
          <a class="btn" href="/">📊 Home</a>
          <a class="btn" href="/deep">🔍 Deep Dive</a>
          <pre>${data.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
        </body>
        </html>`;
      res.send(html);
    });
  });

  // ---------- START ----------
  app.listen(PORT, () => {});
}
