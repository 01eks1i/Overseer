// Express middleware that puts a service behind an x402-style paywall and verifies payments on devnet.
import { randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";
import type { ParsedInstruction, PartiallyDecodedInstruction } from "@solana/web3.js";
import { API_BASE_URL, NETWORK, requireState } from "../lib/config.js";
import { connection, sleep, toBaseUnits } from "../lib/solana.js";
import { decodeHeader, encodeHeader, type PaymentPayload, type PaymentRequired, type PaymentResponse } from "../lib/x402.js";

export interface PricedService {
  id: string;
  priceUsdc: string;
  description: string;
}

interface Challenge {
  serviceId: string;
  amount: bigint;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const challenges = new Map<string, Challenge>();
const usedSignatures = new Set<string>();

export function requirePayment(service: PricedService): RequestHandler {
  return async (req, res, next) => {
    const state = requireState();
    const amount = toBaseUnits(service.priceUsdc, state.decimals);
    const resource = new URL(req.originalUrl, API_BASE_URL).toString();

    const header = req.header("X-PAYMENT");
    if (!header) return sendOffer(res, service, amount, resource, "Payment required");

    let proof: PaymentPayload;
    try {
      proof = decodeHeader<PaymentPayload>(header);
    } catch {
      return sendOffer(res, service, amount, resource, "Malformed X-PAYMENT header");
    }
    const { signature, challenge } = proof.payload ?? {};
    const pending = challenge ? challenges.get(challenge) : undefined;
    if (!signature || !pending || pending.serviceId !== service.id || pending.expiresAt < Date.now()) {
      return sendOffer(res, service, amount, resource, "Unknown or expired payment challenge");
    }
    if (usedSignatures.has(signature)) return sendOffer(res, service, amount, resource, "This payment was already used");

    const verified = await verifyPayment(signature, challenge, pending.amount);
    if (!verified.ok) return sendOffer(res, service, amount, resource, verified.reason);

    usedSignatures.add(signature);
    challenges.delete(challenge);
    const receipt: PaymentResponse = { success: true, transaction: signature, network: NETWORK, payer: verified.payer };
    res.setHeader("X-PAYMENT-RESPONSE", encodeHeader(receipt));
    res.locals.payment = receipt;
    console.log(`[paid] ${service.id} ${service.priceUsdc} USDC from ${verified.payer} (${signature})`);
    next();
  };
}

function sendOffer(res: Response, service: PricedService, amount: bigint, resource: string, error: string) {
  const state = requireState();
  const challenge = randomUUID();
  challenges.set(challenge, { serviceId: service.id, amount, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  const body: PaymentRequired = {
    x402Version: 1,
    error,
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        maxAmountRequired: amount.toString(),
        asset: state.mint,
        payTo: state.merchant,
        resource,
        description: service.description,
        mimeType: "application/json",
        maxTimeoutSeconds: CHALLENGE_TTL_MS / 1000,
        extra: {
          challenge,
          decimals: state.decimals,
          payToTokenAccount: state.merchantTokenAccount,
          memo: `overseer:${challenge}`,
        },
      },
    ],
  };
  res.status(402).json(body);
}

type Verification = { ok: true; payer: string } | { ok: false; reason: string };

const isParsed = (ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction => "parsed" in ix;

async function verifyPayment(signature: string, challenge: string, amount: bigint): Promise<Verification> {
  const state = requireState();
  let tx = null;
  for (let attempt = 0; attempt < 10 && !tx; attempt++) {
    tx = await connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) await sleep(500);
  }
  if (!tx || !tx.meta) return { ok: false, reason: "Payment transaction not found on devnet" };
  if (tx.meta.err) return { ok: false, reason: "Payment transaction failed on-chain" };

  const instructions = tx.transaction.message.instructions.filter(isParsed);
  const hasChallenge = instructions.some(
    (ix) => ix.program === "spl-memo" && typeof ix.parsed === "string" && ix.parsed.includes(challenge),
  );
  if (!hasChallenge) return { ok: false, reason: "Payment is missing the challenge memo" };

  const transfer = instructions.find(
    (ix) =>
      ix.program === "spl-token" &&
      ix.parsed?.type === "transferChecked" &&
      ix.parsed.info.destination === state.merchantTokenAccount &&
      ix.parsed.info.mint === state.mint,
  );
  if (!transfer) return { ok: false, reason: "No transfer to the merchant in this currency" };
  const info = transfer.parsed.info as { source: string; tokenAmount: { amount: string } };
  if (BigInt(info.tokenAmount.amount) < amount) return { ok: false, reason: "Payment amount is too low" };

  // Report the wallet that owns the paying token account (the human), not the agent that signed.
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const sourceIndex = keys.indexOf(info.source);
  const payer = tx.meta.preTokenBalances?.find((b) => b.accountIndex === sourceIndex)?.owner ?? info.source;
  return { ok: true, payer };
}
