# LexPact MCP Server

Exposes the [LexPact](https://lexpact.co.uk) contract generation API to Claude Desktop
(or any MCP client) as three tools: `list_contract_templates`, `generate_contract`,
`get_contract`. Thin proxy only — all validation and generation happens server-side
at `https://lexpact.co.uk/api/v1`, so structured, LLM-actionable error messages reach
Claude unchanged.

## Setup

1. Get an API key at [lexpact.co.uk/dashboard/api-keys](https://lexpact.co.uk/dashboard/api-keys).
2. Install dependencies:
   ```bash
   cd mcp-server
   npm install
   ```
3. Add to your Claude Desktop config (`claude_desktop_config.json` — Settings → Developer →
   Edit Config):
   ```json
   {
     "mcpServers": {
       "lexpact": {
         "command": "node",
         "args": ["/absolute/path/to/mcp-server/index.js"],
         "env": {
           "LEXPACT_API_KEY": "lp_live_your_key_here"
         }
       }
     }
   }
   ```
4. Restart Claude Desktop. Ask it to draft a contract — it will call `list_contract_templates`
   and `generate_contract` as needed.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `LEXPACT_API_KEY` | Yes | Your LexPact API key. |
| `LEXPACT_API_BASE_URL` | No | Override the API base URL (defaults to `https://lexpact.co.uk/api/v1`) — useful for testing against a local dev server. |

## Manual test

```bash
LEXPACT_API_KEY=lp_live_... node index.js
```
Then connect any MCP client (e.g. the MCP Inspector: `npx @modelcontextprotocol/inspector node index.js`).
