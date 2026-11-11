// Fable OS tool server (MCP over stdio). A thin proxy: it advertises the tools and forwards each call to server.js.
const tools = require('./ostools.js')();
const SESSION = process.env.NOOR_SESSION;
// Plain http with no timeout: a call that waits for the user's approval can stay open for many minutes.
const post = o => new Promise((res, rej) => {
  const d = JSON.stringify(o), r = require('http').request({ host: '127.0.0.1', port: process.env.NOOR_PORT || 4747, path: '/api/os', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, s => {
    let b = ''; s.on('data', c => b += c); s.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  r.on('error', rej); r.end(d);
});

const send = o => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
require('readline').createInterface({ input: process.stdin }).on('line', async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notification
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'os', version: '1.0.0' } } });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.props, required: t.required } })) } });
  if (m.method === 'tools/call') {
    try {
      return send({ id: m.id, result: await post({ sessionId: SESSION, tool: m.params?.name, args: m.params?.arguments || {} }) });
    } catch (e) { return send({ id: m.id, result: { content: [{ type: 'text', text: 'Fable OS server unreachable: ' + e.message }], isError: true } }); }
  }
  send({ id: m.id, result: {} });
});
