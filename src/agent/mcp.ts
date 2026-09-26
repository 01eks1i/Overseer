// MCP server that lets Claude pay for APIs out of the allowance its user granted on Solana.
// Speaks MCP over stdio, so nothing in this process may write to stdout except the SDK.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { API_BASE_URL } from "../lib/config.js";
import { paidFetch } from "./paidFetch.js";
import { getAllowance } from "./wallet.js";

const server = new McpServer(
  { name: "overseer", version: "0.1.0" },
  {
    instructions:
      "Overseer gives you a USDC spending allowance on Solana devnet, granted by your user. " +
      "Use overseer_list_services to find paid APIs and overseer_paid_fetch to call them; payments come out of the allowance automatically. " +
      "The limit is enforced on-chain by the Solana Token program. If a payment is blocked, tell the user why, include the explorer link, and do not retry. " +
      "Whenever you pay, tell the user what you paid and include the explorer link.",
  },
);

const asText = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

server.registerTool(
  "overseer_status",
  {
    title: "Allowance status",
    description: "Show how much USDC allowance you have left, the owner's balance, and your SOL for transaction fees.",
  },
  async () => asText(await getAllowance()),
);

server.registerTool(
  "overseer_list_services",
  {
    title: "List paid services",
    description: "List paid APIs you can call with overseer_paid_fetch, with prices in USDC. Defaults to the Overseer marketplace.",
    inputSchema: { catalog_url: z.string().url().optional().describe("Service catalog URL; defaults to the Overseer marketplace") },
  },
  async ({ catalog_url }) => {
    const res = await fetch(catalog_url ?? `${API_BASE_URL}/api/services`);
    return asText(await res.json());
  },
);

server.registerTool(
  "overseer_paid_fetch",
  {
    title: "Fetch a paid API",
    description:
      "Call an HTTP API that may require payment. If it answers 402 Payment Required, Overseer pays from your USDC allowance " +
      "on Solana devnet and retries. Returns the response and a receipt with a Solana Explorer link.",
    inputSchema: {
      url: z.string().url(),
      method: z.enum(["GET", "POST"]).optional(),
      body: z.string().optional().describe("JSON request body, for POST"),
      max_price_usdc: z.number().positive().optional().describe("Refuse to pay more than this for one request"),
    },
  },
  async ({ url, method, body, max_price_usdc }) => {
    const result = await paidFetch(url, { method, body, maxPriceUsdc: max_price_usdc });
    if (result.payment && !result.payment.ok) {
      return {
        ...asText({
          blocked: true,
          message: `Payment blocked on-chain. ${result.payment.reason}`,
          priceUsdc: result.priceUsdc,
          failedTransaction: result.payment.explorer,
        }),
        isError: true,
      };
    }
    if (result.refused) return { ...asText({ refused: result.refused, priceUsdc: result.priceUsdc }), isError: true };
    return asText({
      status: result.status,
      paidUsdc: result.payment?.ok ? result.priceUsdc : "0",
      receipt: result.payment?.ok ? result.payment.explorer : undefined,
      data: result.body,
    });
  },
);

await server.connect(new StdioServerTransport());
