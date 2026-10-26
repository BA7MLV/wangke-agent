import readline from 'node:readline';
process.stderr.write(`fixture ${process.env.MCP_TEST_SECRET ?? ''}\n`);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-03-26', serverInfo: { name: 'stdio fixture', version: '1' }, capabilities: { tools: {} } }
    : message.method === 'tools/list'
      ? { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: `stdio:${process.pid}` }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
