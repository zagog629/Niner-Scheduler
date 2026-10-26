#!/usr/bin/env node
// Tiny static server for local development. No dependencies
// Starts on PORT (default 8080) and moves to the next free port if that one is taken

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    let file = path.join(ROOT, decodeURIComponent(pathname));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = path.join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info) {
      // Same as GitHub Pages: unknown paths get the custom 404 page
      const page = path.join(ROOT, '404.html');
      if (await stat(page).catch(() => null)) {
        res.writeHead(404, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
        createReadStream(page).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(500).end('Server error');
  }
});

const first = Number(process.env.PORT) || 8080;
let port = first;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < first + 20) {
    console.log(`Port ${port} is in use, trying ${port + 1}…`);
    port += 1;
    setTimeout(() => server.listen(port), 50);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});
server.on('listening', () => console.log(`\n  Niner Scheduler is running at http://localhost:${port}\n  Press Ctrl+C to stop.\n`));
server.listen(port);
