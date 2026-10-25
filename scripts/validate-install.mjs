import { loadConfig } from '../dist/config.js';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
const config = await loadConfig();
for (const caller of ['codex', 'dsh']) {
  const client = new Client({ name: 'installation-check', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${config.port}/mcp/${caller}`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${config.tokens[caller]}` },
        },
      },
    ),
  );
  const tools = await client.listTools();
  if (tools.tools.length !== 7) throw new Error('Expected seven task tools');
  const list = await client.callTool({ name: 'agent_list', arguments: {} });
  if (list.isError) throw new Error('agent_list failed');
  console.log(
    `${caller}: authenticated MCP discovery + agent_list OK (${tools.tools.length} tools)`,
  );
  await client.close();
}
