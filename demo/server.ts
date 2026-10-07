import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs from dist/demo/server.js; the static files stay in demo/public.
const publicDir = fileURLToPath(new URL('../../demo/public/', import.meta.url));

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function startDemoServer(port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const loggedIn = /(?:^|;\s*)demo_session=1/.test(req.headers.cookie ?? '');

    if (url.pathname === '/login' && req.method === 'POST') {
      const target = url.searchParams.get('startURL') ?? '/flow.html';
      res.writeHead(302, { 'Set-Cookie': 'demo_session=1; Path=/; SameSite=Lax', Location: target.startsWith('/') ? target : '/flow.html' });
      return res.end();
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': 'demo_session=; Path=/; Max-Age=0', Location: '/login.html' });
      return res.end();
    }
    if (url.pathname === '/' || (url.pathname === '/flow.html' && !loggedIn)) {
      const target = `/flow.html${url.search}`;
      res.writeHead(302, { Location: loggedIn ? target : `/login.html?startURL=${encodeURIComponent(target)}` });
      return res.end();
    }

    const file = path.join(publicDir, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
    if (!file.startsWith(publicDir)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Niet gevonden');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4173);
  startDemoServer(port).then(() => console.log(`Demo-flow draait op http://localhost:${port}/flow.html`));
}
