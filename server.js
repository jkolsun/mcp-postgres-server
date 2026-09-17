import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { spawn } from 'child_process';

const app = express();
app.use(cors());

// ── SPEC_McpPostgresProbe (2026-09-17) — connector handshake responses ──────
//
// These three sit ABOVE express.json() deliberately: the 405 must answer any
// POST to /sse, including one whose body fails to parse. Behind the body
// parser, a malformed payload would be answered with a 400 by express.json()
// before ever reaching this handler, and 400 is just as unclassifiable to the
// client as the 404 was.
//
// 1. Claude.ai's Add-connector flow first POSTs `initialize` to the connector
//    URL to detect a no-auth streamable-HTTP server. This wrapper is SSE-only,
//    so it had no POST /sse route at all and Express answered its default 404.
//    A 404 is unclassifiable: the client cannot tell "wrong URL" from "not
//    streamable HTTP", so it fell through to OAuth discovery, found none, and
//    failed with "Couldn't register with MCP_POSTGRES's sign-in service."
//    405 + Allow: GET is the documented signal for "SSE server, no auth, use
//    GET" — it is what makes the probe succeed rather than a cosmetic status.
//    No child is spawned and no SSE connection is logged: this is a probe, not
//    a session, and treating it as one would leak a server-postgres process
//    per connector check.
app.post('/sse', (req, res) => {
  res.status(405).set({ 'Allow': 'GET', 'Content-Type': 'text/plain' }).send('SSE endpoint: use GET');
});

// 2. Belt: OAuth discovery must get a clean "no OAuth here" rather than
//    whatever a proxy might synthesise later.
app.all('/.well-known/*', (req, res) => {
  res.status(404).end();
});

// 3. A plain root health page, so the domain root is never a 404 for anyone
//    who opens it in a browser.
app.get('/', (req, res) => {
  res.status(200).type('text/plain').send('mcp-postgres ok');
});
// ───────────────────────────────────────────────────────────────────────────

app.use(express.json());

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const sessions = new Map();

app.get('/healthz', (req, res) => {
  res.send('ok');
});

app.get('/sse', (req, res) => {
  const sessionId = crypto.randomUUID();
  console.log(`[${sessionId}] New SSE connection`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const child = spawn('npx', ['-y', '@modelcontextprotocol/server-postgres', DATABASE_URL], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        console.log(`[${sessionId}] Child -> SSE: ${line.substring(0, 200)}`);
        res.write(`event: message\ndata: ${line}\n\n`);
      }
    }
  });

  child.stderr.on('data', (data) => {
    console.error(`[${sessionId}] Child stderr: ${data.toString()}`);
  });

  child.on('close', (code) => {
    console.log(`[${sessionId}] Child exited with code ${code}`);
    sessions.delete(sessionId);
  });

  sessions.set(sessionId, { child, res });

  res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepalive); }
  }, 30000);

  req.on('close', () => {
    console.log(`[${sessionId}] SSE connection closed`);
    clearInterval(keepalive);
    child.kill();
    sessions.delete(sessionId);
  });
});

app.post('/message', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const message = JSON.stringify(req.body);
  console.log(`[${sessionId}] SSE -> Child: ${message.substring(0, 200)}`);
  session.child.stdin.write(message + '\n');
  res.status(202).json({ status: 'accepted' });
});

app.listen(PORT, () => {
  console.log(`MCP Postgres SSE server listening on port ${PORT}`);
});
