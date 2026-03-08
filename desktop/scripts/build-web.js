const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const webPublic = path.resolve(root, '..', 'web', 'src', 'public');
const outDir = path.resolve(root, 'dist');

const apiUrl = process.env.API_URL || 'http://localhost:8000';
const domain = process.env.APP_DOMAIN || process.env.DOMAIN || 'localhost:8000';
const upgradeUrl = process.env.UPGRADE_URL || '';

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const entry of fs.readdirSync(webPublic)) {
  const src = path.join(webPublic, entry);
  const dest = path.join(outDir, entry);
  fs.cpSync(src, dest, { recursive: true });
}

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vibes Platform</title>
    <link rel="icon" type="image/png" href="/favicon.png" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <script>
      window.__API_URL__ = ${JSON.stringify(apiUrl)};
      window.__DOMAIN__ = ${JSON.stringify(domain)};
      window.__UPGRADE_URL__ = ${JSON.stringify(upgradeUrl)};
    </script>
    <app-shell></app-shell>
    <script src="${apiUrl}/socket.io/socket.io.js"></script>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log(`Desktop web assets built at ${outDir}`);
