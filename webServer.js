// webServer.js
import express from 'express';

const PORT = process.env.PORT || 3000;

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

  // ---------- START ----------
  app.listen(PORT, () => {});
}
