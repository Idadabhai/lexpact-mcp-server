#!/usr/bin/env node
// LexPact MCP server — thin proxy over https://lexpact.co.uk/api/v1.
// No business logic lives here; validation and generation happen server-side
// so the REST API's LLM-friendly error messages (error.suggestion) reach the
// model unchanged whichever way it was called.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY = process.env.LEXPACT_API_KEY;
const BASE_URL = process.env.LEXPACT_API_BASE_URL || 'https://lexpact.co.uk/api/v1';

if (!API_KEY) {
  console.error('LEXPACT_API_KEY is not set. Get a key at https://lexpact.co.uk/dashboard/api-keys and set it in your MCP client config.');
  process.exit(1);
}

async function callApi(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      ...(options.headers || {}),
    },
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, body };
}

function textResult(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError };
}

const server = new McpServer({ name: 'lexpact', version: '1.0.0' });

server.registerTool(
  'list_contract_templates',
  {
    title: 'List LexPact contract templates',
    description: "List the 5 contract types LexPact can generate, their required/optional fields, and party role labels. Call this first if you don't already know the field requirements for a contract_type.",
    inputSchema: {},
  },
  async () => {
    const { body } = await callApi('/templates', { method: 'GET' });
    return textResult(body);
  }
);

server.registerTool(
  'generate_contract',
  {
    title: 'Generate a contract',
    description: 'Generate a UK jurisdiction-aware contract (nda, service_agreement, freelance_agreement, recruiter_terms_of_business, or ir35_agreement). Collect all required fields through conversation before calling — never invent party names, addresses, dates, or amounts. On a validation error, read error.suggestion in the response and fix the request yourself.',
    inputSchema: {
      contract_type: z
        .enum(['nda', 'service_agreement', 'freelance_agreement', 'recruiter_terms_of_business', 'ir35_agreement'])
        .describe('Which contract to generate. Call list_contract_templates if unsure which fields each type needs.'),
      parties: z
        .array(
          z.object({
            role: z.enum(['party_a', 'party_b']),
            name: z.string().describe('Full legal name.'),
            address: z.string().describe('Full postal address.'),
          })
        )
        .length(2)
        .describe('Exactly two parties, in order: party_a first, then party_b.'),
      effective_date: z.string().describe('Contract start date, YYYY-MM-DD.'),
      jurisdiction: z
        .enum(['UK_ENGLAND_WALES', 'UK_SCOTLAND', 'UK_NORTHERN_IRELAND', 'INTERNATIONAL'])
        .describe('Governing jurisdiction.'),
      jurisdiction_other: z.string().optional().describe('Required only when jurisdiction is INTERNATIONAL.'),
      scope_of_work: z.string().describe('Plain-English description of what this contract covers.'),
      output_format: z.enum(['markdown', 'pdf']).optional().describe('Default markdown. pdf returns a 1-hour signed download URL instead.'),
      payment: z
        .record(z.string(), z.any())
        .optional()
        .describe('Payment terms — shape depends on contract_type (service_agreement/freelance_agreement/ir35_agreement). Call list_contract_templates for the exact fields.'),
      fee: z.record(z.string(), z.any()).optional().describe('Recruitment fee terms — recruiter_terms_of_business only.'),
      deliverables: z.string().optional().describe('service_agreement only — required for that type.'),
      ip_ownership: z.enum(['client', 'consultant']).optional().describe('service_agreement only.'),
      nda_type: z.enum(['mutual', 'unilateral']).optional().describe('nda only.'),
      duration_months: z.string().optional().describe('nda only.'),
      kill_fee_percentage: z.number().optional().describe('freelance_agreement only.'),
      substitution_clause: z.boolean().optional().describe('ir35_agreement only.'),
      custom_terms: z.record(z.string(), z.any()).optional().describe('Optional free-text extension, e.g. { additional_clauses: "..." }.'),
    },
  },
  async (args, extra) => {
    // The API is async: this returns 202 + a status_url immediately, then the
    // actual generation happens server-side (typically 1-3 min depending on
    // contract_type). We poll here for a bounded time so short jobs return the
    // finished contract directly. MCP clients enforce their own request timeout
    // (the official SDK client defaults to 60s; Claude Desktop is similar), so
    // holding the call open for the whole generation makes the client give up
    // while the job is still running. We therefore stop waiting well inside
    // that window, send progress notifications while we wait (clients that
    // support it reset their timeout), and otherwise hand back the job id with
    // an instruction to call get_contract.
    const { ok, body } = await callApi('/contracts/generate', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    if (!ok) return textResult(body, true);

    const contractId = body.id;
    const POLL_INTERVAL_MS = 3000;
    const MAX_WAIT_MS = Number(process.env.LEXPACT_MAX_WAIT_MS) || 45 * 1000;
    const deadline = Date.now() + MAX_WAIT_MS;
    const progressToken = extra?._meta?.progressToken;
    let tick = 0;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const poll = await callApi(`/contracts/${contractId}`, { method: 'GET' });
      if (!poll.ok) return textResult(poll.body, true);
      if (poll.body.status === 'completed') return textResult(poll.body);
      if (poll.body.status === 'failed') return textResult(poll.body, true);
      // status === 'processing' — keep polling
      if (progressToken !== undefined) {
        tick += 1;
        await extra
          .sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: tick, message: 'Generating contract…' },
          })
          .catch(() => {});
      }
    }

    return textResult({
      id: contractId,
      status: 'processing',
      message: 'The contract is still being generated (usually 1 to 3 minutes). This is normal, not an error.',
      next_step: `Wait about 30 seconds, then call get_contract with id "${contractId}". Repeat until status is "completed". Do not call generate_contract again: that would start a second job and use more of the quota.`,
    });
  }
);

server.registerTool(
  'get_contract',
  {
    title: 'Get a previously generated contract',
    description: 'Retrieve a contract by id. Returns status "processing" while generation is still running (call again in about 30 seconds) and "completed" with the contract once done. content_markdown is always populated regardless of the original output_format — PDF URLs are only returned once, inline, by generate_contract.',
    inputSchema: {
      id: z.string().describe('The contract id returned by generate_contract.'),
    },
  },
  async ({ id }) => {
    const { ok, body } = await callApi(`/contracts/${encodeURIComponent(id)}`, { method: 'GET' });
    return textResult(body, !ok);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
