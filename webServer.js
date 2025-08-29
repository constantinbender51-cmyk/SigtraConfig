import express from 'express';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 3000;
const logFilePath = path.join(process.cwd(), 'logs', 'metrics.ndjson');
const tradeLogFilePath = path.join(process.cwd(), 'trades.json');

// ----------------------------------------
// Express setup
// ----------------------------------------
export function startWebServer() {
    const app = express();

    // API endpoint to fetch the logs
    app.get('/api/logs', (req, res) => {
        // Check if the log directory and file exist
        if (!fs.existsSync(logFilePath)) {
            // Log this event for debugging on the server
            console.warn('Log file does not exist. Sending empty log array.');
            return res.json([]);
        }

        try {
            // Read the log file and process its contents
            const fileContent = fs.readFileSync(logFilePath, 'utf8');
            const lines = fileContent.split('\n').filter(Boolean); // Filter out any empty lines
            
            // Handle the case of an empty log file
            if (lines.length === 0) {
                return res.json([]);
            }
            
            const logs = lines.map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    console.error('Failed to parse log line:', line);
                    return null;
                }
            }).filter(Boolean);
            res.json(logs);
        } catch (error) {
            // This catches errors like file permission issues
            console.error('Error reading log file:', error);
            // Send a 500 Internal Server Error status to the client
            res.status(500).json({ error: 'Failed to read logs due to a server error.' });
        }
    });

    // API endpoint to fetch the trades
    app.get('/api/trades', (req, res) => {
        if (!fs.existsSync(tradeLogFilePath)) {
            console.warn('Trade log file does not exist. Sending empty array.');
            return res.json([]);
        }

        try {
            const fileContent = fs.readFileSync(tradeLogFilePath, 'utf8');
            const trades = JSON.parse(fileContent);
            res.json(trades);
        } catch (error) {
            console.error('Error reading trades file:', error);
            res.status(500).json({ error: 'Failed to read trades due to a server error.' });
        }
    });

    // Main page to display the live logs and trades
    app.get('/', (req, res) => {
        const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sigtra Live Logs & Trades</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap');
          body {
            font-family: 'Inter', sans-serif;
            background-color: #f3f4f6;
            color: #1f2937;
          }
          .tab-button.active {
            background-color: #1f2937;
            color: #ffffff;
            border-bottom: 2px solid #3b82f6;
          }
        </style>
      </head>
      <body class="bg-gray-100 min-h-screen flex flex-col items-center p-4">
        <div class="bg-white rounded-xl shadow-lg p-6 w-full max-w-4xl">
          <h1 class="text-3xl font-bold text-center text-blue-600 mb-4">Sigtra Dashboard</h1>
          <p class="text-center text-gray-500 mb-6">Real-time feed of the trading bot's activity.</p>
          
          <!-- Tab Navigation -->
          <div class="flex border-b border-gray-300 mb-4">
            <button id="logs-tab" class="tab-button active flex-1 py-2 px-4 text-sm font-medium text-center rounded-t-lg focus:outline-none transition-colors duration-200">
              Live Logs
            </button>
            <button id="trades-tab" class="tab-button flex-1 py-2 px-4 text-sm font-medium text-center rounded-t-lg focus:outline-none transition-colors duration-200">
              Trade History
            </button>
          </div>

          <!-- Content Containers -->
          <div id="logs-content" class="tab-content bg-gray-800 text-gray-200 text-sm font-mono p-4 rounded-lg h-96 overflow-y-scroll space-y-2">
            <p class="text-center text-gray-400">Loading logs...</p>
          </div>
          <div id="trades-content" class="tab-content hidden p-4">
            <p class="text-center text-gray-400">No trades to display yet...</p>
          </div>
        </div>

        <script>
          const logsTab = document.getElementById('logs-tab');
          const tradesTab = document.getElementById('trades-tab');
          const logsContent = document.getElementById('logs-content');
          const tradesContent = document.getElementById('trades-content');
          const logContainer = document.getElementById('logs-content');

          // State for current view
          let currentView = 'logs';

          // Tab switching function
          function switchTab(tab) {
            if (tab === 'logs') {
              logsTab.classList.add('active');
              tradesTab.classList.remove('active');
              logsContent.classList.remove('hidden');
              tradesContent.classList.add('hidden');
              currentView = 'logs';
            } else {
              logsTab.classList.remove('active');
              tradesTab.classList.add('active');
              logsContent.classList.add('hidden');
              tradesContent.classList.remove('hidden');
              currentView = 'trades';
              fetchTrades();
            }
          }

          logsTab.addEventListener('click', () => switchTab('logs'));
          tradesTab.addEventListener('click', () => switchTab('trades'));
          
          // --- Log fetching logic ---
          async function fetchLogs() {
            if (currentView !== 'logs') return;
            try {
              const response = await fetch('/api/logs');
              if (!response.ok) {
                throw new Error(\`Failed to fetch logs: \${response.status} \${response.statusText}\`);
              }
              const logs = await response.json();
              displayLogs(logs);
            } catch (error) {
              console.error(error);
              logContainer.innerHTML = \`<p class="text-center text-red-400">Error loading logs. Please check the server logs for details. (\${error.message})</p>\`;
            }
          }

          function displayLogs(logs) {
            logContainer.innerHTML = '';
            if (logs.length === 0) {
              logContainer.innerHTML = '<p class="text-center text-gray-400">No logs to display yet...</p>';
              return;
            }

            logs.forEach(log => {
              const logLine = document.createElement('p');
              let className = 'text-gray-200';
              if (log.level === 'WARN') {
                className = 'text-yellow-400';
              } else if (log.level === 'ERROR') {
                className = 'text-red-400';
              } else if (log.level === 'INFO') {
                className = 'text-blue-400';
              }

              const fullMessage = log.extra && log.extra.length > 0
                ? \`\${log.msg} \${log.extra.map(e => JSON.stringify(e)).join(' ')}\`
                : log.msg;

              logLine.className = \`\${className}\`;
              logLine.textContent = \`[\${log.level.padEnd(5)}] \${fullMessage}\`;
              logContainer.appendChild(logLine);
            });
            logContainer.scrollTop = logContainer.scrollHeight;
          }

          // --- Trade fetching logic ---
          async function fetchTrades() {
            if (currentView !== 'trades') return;
            try {
              const response = await fetch('/api/trades');
              if (!response.ok) {
                throw new Error(\`Failed to fetch trades: \${response.status} \${response.statusText}\`);
              }
              const trades = await response.json();
              displayTrades(trades);
            } catch (error) {
              console.error(error);
              tradesContent.innerHTML = \`<p class="text-center text-red-400">Error loading trades. Please check the server logs for details. (\${error.message})</p>\`;
            }
          }
          
          function displayTrades(trades) {
            if (trades.length === 0) {
              tradesContent.innerHTML = '<p class="text-center text-gray-400">No trades to display yet...</p>';
              return;
            }

            const tableHtml = \`
              <div class="overflow-x-auto rounded-lg shadow-md">
                <table class="w-full text-left text-sm text-gray-500">
                  <thead class="text-xs text-gray-700 uppercase bg-gray-50">
                    <tr>
                      <th scope="col" class="py-3 px-6 rounded-tl-lg">ID</th>
                      <th scope="col" class="py-3 px-6">Side</th>
                      <th scope="col" class="py-3 px-6">Size</th>
                      <th scope="col" class="py-3 px-6">Entry Price</th>
                      <th scope="col" class="py-3 px-6">P&L</th>
                      <th scope="col" class="py-3 px-6 rounded-tr-lg">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    \${trades.map(trade => \`
                      <tr class="bg-white border-b hover:bg-gray-50">
                        <td class="py-4 px-6 font-medium text-gray-900 whitespace-nowrap">\${trade.id.substring(0, 8)}...</td>
                        <td class="py-4 px-6 \${trade.side === 'BUY' ? 'text-green-600' : 'text-red-600'}">\${trade.side}</td>
                        <td class="py-4 px-6">\${trade.size}</td>
                        <td class="py-4 px-6">\${trade.lastPrice.toFixed(2)}</td>
                        <td class="py-4 px-6 \${(trade.pnl > 0) ? 'text-green-600' : (trade.pnl < 0) ? 'text-red-600' : 'text-gray-500'}">\${trade.pnl !== null ? trade.pnl : 'Pending'}</td>
                        <td class="py-4 px-6">
                            <span class="text-xs text-gray-500 block">SL: \${trade.stopLoss.toFixed(2)}</span>
                            <span class="text-xs text-gray-500 block">TP: \${trade.takeProfit.toFixed(2)}</span>
                        </td>
                      </tr>
                    \`).join('')}
                  </tbody>
                </table>
              </div>
            \`;
            tradesContent.innerHTML = tableHtml;
          }

          // Initial fetch and set up interval for periodic updates
          fetchLogs();
          setInterval(fetchLogs, 5000);
          setInterval(fetchTrades, 5000);
        </script>
      </body>
      </html>`;
        res.send(html);
    });

    // ---------- START ----------
    app.listen(PORT, () => {});
}
