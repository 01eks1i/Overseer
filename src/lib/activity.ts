// Turns the transaction history of a project budget account into activity-feed rows for the web app.
import type { ConfirmedSignatureInfo, ParsedInstruction, ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import { fromBaseUnits } from "./solana.js";

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

const shorten = (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;
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
  // Memo formats: "overseer:<challenge> <amount> USDC · <service description>", "overseer: <note>", "overseer:refund <payment>"
  const note = memo?.replace(/^overseer:(\S*)\s*/, "").replace(/^[\d.]+ USDC · /, "") || undefined;
  const token = instructions.filter((ix) => ix.program === "spl-token").map((ix) => ix.parsed as TokenIx);
  const failed = !!tx.meta?.err;
  const base = { signature, time: tx.blockTime ?? null };
  const amountOf = (t?: TokenIx): string | undefined =>
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

  if (!failed && token.some((t) => t.type.startsWith("initializeAccount") && t.info.account === account)) {
    return { ...base, kind: "created", title: "Project created", detail: "Budget account opened on Solana" };
  }

  const mint = token.find((t) => t.type.startsWith("mintTo") && t.info.account === account);
  if (mint && !failed) return { ...base, kind: "funded", title: `Received ${amountOf(mint)} test USDC`, amount: amountOf(mint) };

  return null;
}

/**
 * A feed row built from the signature list alone (memo, status and time), without fetching the transaction.
 * The public RPC often refuses per-transaction lookups under load, but the signature list still answers,
 * and ApiSift's memos say what happened. Returns null for transactions without an ApiSift memo.
 */
export function activityFromSignature(info: ConfirmedSignatureInfo): Activity | null {
  // The RPC reports memos as "[<length>] <text>", joined by "; " when there are several.
  const memo = info.memo?.replace(/^\[\d+\]\s*/, "") ?? "";
  const base = { signature: info.signature, time: info.blockTime ?? null };
  const failed = !!info.err;
  let m: RegExpMatchArray | null;

  if ((m = memo.match(/^overseer: allowance set to ([\d.]+) USDC/))) {
    return failed ? { ...base, kind: "failed", title: "Setting the allowance failed" } : { ...base, kind: "allowance", title: `Allowance set to ${m[1]} USDC`, amount: m[1] };
  }
  if (memo.startsWith("overseer: allowance revoked")) {
    return failed ? { ...base, kind: "failed", title: "Revoking failed" } : { ...base, kind: "revoked", title: "Allowance revoked" };
  }
  if (memo.startsWith("overseer:refund") && !failed) {
    return { ...base, kind: "refunded", title: "Refunded", detail: "The service failed after payment, so the money came back" };
  }
  if (memo.startsWith("overseer: project") && !failed) {
    return { ...base, kind: "created", title: "Project created", detail: "Budget account opened on Solana" };
  }
  if ((m = memo.match(/^overseer:[0-9a-f-]{36}\s*(?:([\d.]+) USDC · )?(.*)$/))) {
    const [, amount, detail] = m;
    const what = amount ? `${amount} USDC` : "";
    return failed
      ? { ...base, kind: "blocked", title: `Blocked by Solana${what ? `: ${what}` : ""}`, detail: detail || undefined, amount }
      : { ...base, kind: "paid", title: `Agent paid${what ? ` ${what}` : ""}`, detail: detail || undefined, amount };
  }
  return null;
}
