// Devnet reads for the dashboard: turns a project budget account's transaction history into the activity
// feed. Balances and allowances come from the ApiSift office API (see api.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { config } from "./config";

const POLL_MS = 3000;

export const connection = new Connection(config?.rpcUrl ?? "https://api.devnet.solana.com", "confirmed");

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;
export const shorten = (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;

export function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromBaseUnits(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}

export type ActivityKind = "paid" | "blocked" | "refunded" | "allowance" | "revoked" | "funded" | "withdrawn" | "created" | "failed";

export interface Activity {
  signature: string;
  time: number | null;
  kind: ActivityKind;
  title: string;
  detail?: string;
  /** Amount in USDC for payments, allowances and transfers. */
  amount?: string;
}

type TokenIx = { type: string; info: Record<string, any> };

const isParsed = (ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction => "parsed" in ix;

/** Classifies one transaction touching `account` (a project budget), most specific instruction first. */
export function parseActivity(
  signature: string,
  tx: ParsedTransactionWithMeta,
  account: string,
  agent: string,
  decimals: number,
): Activity | null {
  const instructions = tx.transaction.message.instructions.filter(isParsed);
  const memo = instructions.find((ix) => ix.program === "spl-memo")?.parsed as string | undefined;
  // Memo formats: "overseer:<challenge> <service description>", "overseer: <note>", "overseer:refund <payment>"
  const note = memo?.replace(/^overseer:(\S*)\s*/, "") || undefined;
  const token = instructions.filter((ix) => ix.program === "spl-token").map((ix) => ix.parsed as TokenIx);
  const failed = !!tx.meta?.err;
  const base = { signature, time: tx.blockTime ?? null };
  const amountOf = (t?: TokenIx) =>
    t && (t.info.tokenAmount?.uiAmountString ?? (t.info.amount !== undefined ? fromBaseUnits(BigInt(t.info.amount), decimals) : undefined));
  const isTransfer = (t: TokenIx) => t.type === "transferChecked" || t.type === "transfer";
  const transferIn = token.find((t) => isTransfer(t) && t.info.destination === account);
  const transferOut = token.find((t) => isTransfer(t) && t.info.source === account);

  const approve = token.find((t) => t.type.startsWith("approve") && t.info.source === account);
  if (approve) {
    if (failed) return { ...base, kind: "failed", title: "Setting the allowance failed" };
    const topUp = amountOf(transferIn);
    const toAgent = approve.info.delegate === agent;
    return {
      ...base,
      kind: "allowance",
      title: `Allowance set to ${amountOf(approve)} USDC`,
      detail: !toAgent ? `Delegate ${shorten(approve.info.delegate)} is not this project's agent` : topUp ? `Budget topped up by ${topUp} USDC` : undefined,
      amount: amountOf(approve),
    };
  }

  if (token.some((t) => t.type === "revoke" && t.info.source === account)) {
    if (failed) return { ...base, kind: "failed", title: "Revoking failed" };
    const returned = amountOf(transferOut);
    return { ...base, kind: "revoked", title: "Allowance revoked", detail: returned ? `${returned} USDC returned to the wallet` : undefined };
  }

  if (transferOut && (transferOut.info.authority ?? transferOut.info.multisigAuthority) === agent) {
    const amount = amountOf(transferOut);
    if (failed) return { ...base, kind: "blocked", title: `Blocked by Solana: ${amount} USDC`, detail: note, amount };
    return { ...base, kind: "paid", title: `Agent paid ${amount} USDC`, detail: note, amount };
  }

  if (transferIn && !failed) {
    const amount = amountOf(transferIn);
    if (memo?.startsWith("overseer:refund")) {
      return { ...base, kind: "refunded", title: `Refunded ${amount} USDC`, detail: "The service failed after payment, so the money came back", amount };
    }
    return { ...base, kind: "funded", title: `Budget topped up by ${amount} USDC`, amount };
  }

  if (transferOut && !failed) {
    return { ...base, kind: "withdrawn", title: `${amountOf(transferOut)} USDC moved back to the wallet`, amount: amountOf(transferOut) };
  }

  if (token.some((t) => t.type.startsWith("initializeAccount") && t.info.account === account) && !failed) {
    return { ...base, kind: "created", title: "Project created", detail: "Budget account opened on Solana" };
  }

  const mint = token.find((t) => t.type.startsWith("mintTo") && t.info.account === account);
  if (mint && !failed) return { ...base, kind: "funded", title: `Received ${amountOf(mint)} test USDC`, amount: amountOf(mint) };

  return null;
}

/** Polls the transaction history of a project's budget account and parses it into feed rows. */
export function useActivity(account: string, agent: string, decimals: number) {
  const [activity, setActivity] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const parsed = useRef(new Map<string, Activity | null>());
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const sigs = await connection.getSignaturesForAddress(new PublicKey(account), { limit: 30 });
      const unseen = sigs.map((s) => s.signature).filter((s) => !parsed.current.has(s));
      if (unseen.length) {
        const txs = await connection.getParsedTransactions(unseen, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        // Batched RPC responses can come back out of order, so key each result by its own signature.
        // Transactions not found yet stay unseen and are retried on the next poll.
        for (const tx of txs) {
          if (!tx) continue;
          const signature = tx.transaction.signatures[0];
          parsed.current.set(signature, parseActivity(signature, tx, account, agent, decimals));
        }
      }
      setActivity(sigs.map((s) => parsed.current.get(s.signature)).filter((a): a is Activity => !!a));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, [account, agent, decimals]);

  useEffect(() => {
    parsed.current.clear();
    setActivity([]);
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { activity, error, refresh: () => void refresh() };
}
