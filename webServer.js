import express from 'express';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 3000;
const logFilePath = path.join(process.cwd(), 'logs', 'metrics.ndjson');

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
            const lines = fileContent.split('\n').filter(Boolean);
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

    // Main page to display the live logs
    app.get('/', (req, res) => {
        const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sigtra Live Logs</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap');
          body {
            font-family: 'Inter', sans-serif;
            background-color: #f3f4f6;
            color: #1f2937;
          }
        </style>
      </head>
      <body class="bg-gray-100 min-h-screen flex flex-col items-center p-4">
        <div class="bg-white rounded-xl shadow-lg p-6 w-full max-w-4xl">
          <h1 class="text-3xl font-bold text-center text-blue-600 mb-4">Sigtra Live Logs</h1>
          <p class="text-center text-gray-500 mb-6">Real-time feed of the trading bot's activity.</p>
          <div id="log-container" class="bg-gray-800 text-gray-200 text-sm font-mono p-4 rounded-lg h-96 overflow-y-scroll space-y-2">
            <p class="text-center text-gray-400">Loading logs...</p>
          </div>
        </div>

        <script>
          const logContainer = document.getElementById('log-container');
          
          async function fetchLogs() {
            try {
              const response = await fetch('/api/logs');
              if (!response.ok) {
                // If the server returns a non-200 status, we'll get here.
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
                logLine.textContent = \`[\${new Date(log.ts).toLocaleTimeString()}] [\${log.level.padEnd(5)}] \${fullMessage}\`;
                logContainer.appendChild(logLine);
            });
            logContainer.scrollTop = logContainer.scrollHeight;
          }

          // Initial fetch and set up interval for periodic updates
          fetchLogs();
          setInterval(fetchLogs, 5000); // Refresh every 5 seconds
        </script>
      </body>
      </html>`;
        res.send(html);
    });

    // ---------- START ----------
    app.listen(PORT, () => {});
}
