// fetch() that settles HTTP 402 responses from the agent's allowance.
import { PublicKey } from "@solana/web3.js";
import { NETWORK, requireState } from "../lib/config.js";
import { fromBaseUnits } from "../lib/solana.js";
import { decodeHeader, encodeHeader, type PaymentPayload, type PaymentRequired, type PaymentResponse } from "../lib/x402.js";
import { payFromAllowance, type PaymentResult } from "./wallet.js";

export interface PaidFetchOptions {
  method?: "GET" | "POST";
  body?: string;
  /** The agent's own per-request price limit. The chain-enforced cap is the allowance itself. */
  maxPriceUsdc?: number;
  /** ApiSift project whose budget pays; defaults to the original single agent. */
  project?: string;
}

export interface PaidFetchResult {
  status: number;
  body: unknown;
  priceUsdc?: string;
  payment?: PaymentResult;
  settlement?: PaymentResponse;
  refused?: string;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function paidFetch(url: string, options: PaidFetchOptions = {}): Promise<PaidFetchResult> {
  const headers: Record<string, string> = options.body ? { "Content-Type": "application/json" } : {};
  const init: RequestInit = { method: options.method ?? "GET", headers, body: options.body };

  const first = await fetch(url, init);
  if (first.status !== 402) return { status: first.status, body: await readBody(first) };

  const required = (await first.json()) as PaymentRequired;
  const state = requireState();
  const offer = required.accepts?.find((o) => o.scheme === "exact" && o.network === NETWORK && o.asset === state.mint);
  if (!offer) {
    return { status: 402, body: required, refused: "The server asks for a payment Overseer can't make (different network or currency)." };
  }

  const price = BigInt(offer.maxAmountRequired);
  const priceUsdc = fromBaseUnits(price, offer.extra.decimals);
  if (options.maxPriceUsdc !== undefined && Number(priceUsdc) > options.maxPriceUsdc) {
    return { status: 402, body: required, priceUsdc, refused: `Price ${priceUsdc} USDC is above the requested limit of ${options.maxPriceUsdc} USDC.` };
  }

  const payment = await payFromAllowance(
    new PublicKey(offer.extra.payToTokenAccount),
    price,
    `${offer.extra.memo} ${priceUsdc} USDC · ${offer.description}`,
    options.project,
  );
  if (!payment.ok) return { status: 402, body: null, priceUsdc, payment };

  const proof: PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: NETWORK,
    payload: { signature: payment.signature, challenge: offer.extra.challenge },
  };
  const second = await fetch(url, { ...init, headers: { ...headers, "X-PAYMENT": encodeHeader(proof) } });
  const settlementHeader = second.headers.get("X-PAYMENT-RESPONSE");
  return {
    status: second.status,
    body: await readBody(second),
    priceUsdc,
    payment,
    settlement: settlementHeader ? decodeHeader<PaymentResponse>(settlementHeader) : undefined,
  };
}
