import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local', override: true });
}
dotenv.config({ override: true });

const app = express();
const port = Number(process.env.WEB_PORT || 8080);
const apiUrl = process.env.API_URL || 'http://localhost:8000';
const domain = process.env.APP_DOMAIN || process.env.DOMAIN || 'localhost:8000';
const upgradeUrl = process.env.UPGRADE_URL || '';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

app.use('/static', express.static(publicDir));
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(publicDir, 'favicon.ico'));
});

app.get('/', (req, res) => {
  res.send(`<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Vibes Platform</title>
      <link rel="icon" type="image/png" href="/static/favicon.png" />
      <link rel="icon" href="/favicon.ico" sizes="any" />
      <link rel="stylesheet" href="/static/styles.css" />
    </head>
    <body>
      <script>
        window.__API_URL__ = ${JSON.stringify(apiUrl)};
        window.__DOMAIN__ = ${JSON.stringify(domain)};
        window.__UPGRADE_URL__ = ${JSON.stringify(upgradeUrl)};
      </script>
      <app-shell></app-shell>
      <script src="${apiUrl}/socket.io/socket.io.js"></script>
      <script type="module" src="/static/app.js"></script>
    </body>
  </html>`);
});

app.listen(port, () => {
  console.log(`Web listening on ${port}`);
});
