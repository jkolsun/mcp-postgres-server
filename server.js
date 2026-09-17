import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { spawn } from 'child_process';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const app = express();
app.use(cors());

// Streamable HTTP carries its session id in a header, so it has to be both
// allowed on the way in and exposed on the way out — cors() alone does not
// expose custom response headers. Modelled on bright-engine-mcp, which is the
// server in this project that already connects cleanly.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-session-id');
  res.header('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

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

// ── Streamable HTTP on /mcp (2026-09-17) ───────────────────────────────────
//
// The real fix behind SPEC_McpPostgresProbe's 405: SSE is deprecated in
// Claude's Add-connector dialog. Modelled on bright-engine-mcp — the server in
// this same Railway project that already connects cleanly — so the shape here
// is deliberately identical: stateless transport, a fresh McpServer per
// request, 405 on GET/DELETE.
//
// The single `query` tool keeps the name, description and input schema the
// stdio child exposed (@modelcontextprotocol/server-postgres), so nothing that
// already calls this connector has to change.
//
// One pool for the process, rather than the child's one-connection-per-session:
// /mcp is stateless, so a pool is what keeps a burst of tool calls from opening
// a connection each.
const pool = new pg.Pool({ connectionString: DATABASE_URL });

pool.on('error', (err) => {
  // An idle client erroring out must not take the process down.
  console.error('[pg] idle client error:', err.message);
});

/**
 * Read-only by construction, not by inspection.
 *
 * The upstream stdio server ran every statement inside `BEGIN TRANSACTION
 * READ ONLY` and rolled it back, and that is reproduced exactly here. It
 * matters: Postgres itself refuses writes in such a transaction, so this holds
 * for anything the caller sends — including statements a regex blocklist would
 * miss (a write hidden in a CTE, a function call with side effects, DDL). The
 * ROLLBACK is in a finally so a failed query cannot leave the connection
 * inside an open transaction when it returns to the pool.
 */
async function runReadOnlyQuery(sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const result = await client.query(sql);
    return result.rows;
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch (err) {
      console.error('[pg] rollback failed:', err.message);
    }
    client.release();
  }
}

function createMcpServer() {
  const server = new McpServer({ name: 'mcp-postgres', version: '1.0.0' });

  server.tool(
    'query',
    'Run a read-only SQL query',
    { sql: z.string().describe('The SQL query to run. Executed inside a READ ONLY transaction.') },
    async ({ sql }) => {
      try {
        const rows = await runReadOnlyQuery(sql);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    },
  );

  return server;
}

app.post('/mcp', async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP POST error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Stateless: there is no stream to resume and no session to delete.
app.get('/mcp', (req, res) => {
  res.status(405).json({ error: 'Method not allowed in stateless mode' });
});
app.delete('/mcp', (req, res) => {
  res.status(405).json({ error: 'Method not allowed in stateless mode' });
});
// ───────────────────────────────────────────────────────────────────────────

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
