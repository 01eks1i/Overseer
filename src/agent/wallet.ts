// The agent's side of Overseer. The agent never holds the owner's funds: it signs token transfers
// as the *delegate* of the owner's token account, so the SPL Token program enforces the cap.
import { LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { requireState } from "../lib/config.js";
import { connection, describeTxError, explorerTx, fromBaseUnits, loadKeypair, memoInstruction } from "../lib/solana.js";

const agent = loadKeypair("agent");

export interface AllowanceStatus {
  agent: string;
  owner: string;
  ownerTokenAccount: string;
  mint: string;
  ownerBalanceUsdc: string;
  allowanceUsdc: string;
  delegatedToAgent: boolean;
  agentSolForFees: number;
}

export async function getAllowance(): Promise<AllowanceStatus> {
  const state = requireState();
  const mint = new PublicKey(state.mint);
  const ownerTokenAccount = getAssociatedTokenAddressSync(mint, new PublicKey(state.owner));
  const account = await getAccount(connection, ownerTokenAccount).catch(() => null);
  const delegatedToAgent = !!account?.delegate?.equals(agent.publicKey);
  return {
    agent: agent.publicKey.toBase58(),
    owner: state.owner,
    ownerTokenAccount: ownerTokenAccount.toBase58(),
    mint: state.mint,
    ownerBalanceUsdc: fromBaseUnits(account?.amount ?? 0n, state.decimals),
    allowanceUsdc: fromBaseUnits(delegatedToAgent ? account!.delegatedAmount : 0n, state.decimals),
    delegatedToAgent,
    agentSolForFees: (await connection.getBalance(agent.publicKey)) / LAMPORTS_PER_SOL,
  };
}

export type PaymentResult =
  | { ok: true; signature: string; explorer: string; amountUsdc: string }
  | { ok: false; reason: string; signature?: string; explorer?: string; amountUsdc: string };

/**
 * Pays `amount` base units to `destination` from the owner's token account, signing only as delegate.
 * There is deliberately no client-side allowance check: the transaction is always submitted, so an
 * overspend is rejected by the Token program itself and leaves a failed transaction on the explorer.
 */
export async function payFromAllowance(destination: PublicKey, amount: bigint, memo: string): Promise<PaymentResult> {
  const state = requireState();
  const mint = new PublicKey(state.mint);
  const source = getAssociatedTokenAddressSync(mint, new PublicKey(state.owner));
  const amountUsdc = fromBaseUnits(amount, state.decimals);

  const tx = new Transaction().add(
    createTransferCheckedInstruction(source, mint, destination, agent.publicKey, amount, state.decimals),
    memoInstruction(memo.slice(0, 200)),
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.feePayer = agent.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(agent);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (!confirmation.value.err) return { ok: true, signature, explorer: explorerTx(signature), amountUsdc };

  return {
    ok: false,
    reason: await explainRejection(source, amount, state.decimals, describeTxError(confirmation.value.err)),
    signature,
    explorer: explorerTx(signature),
    amountUsdc,
  };
}

async function explainRejection(source: PublicKey, amount: bigint, decimals: number, chainError: string): Promise<string> {
  const account = await getAccount(connection, source).catch(() => null);
  const prefix = `Rejected by the Solana Token program (${chainError}).`;
  if (!account) return `${prefix} The owner has no token account for this currency.`;
  if (!account.delegate?.equals(agent.publicKey)) return `${prefix} The owner has not granted this agent an allowance, or revoked it.`;
  if (account.delegatedAmount < amount) {
    return `${prefix} Allowance exceeded: this costs ${fromBaseUnits(amount, decimals)} USDC but only ${fromBaseUnits(account.delegatedAmount, decimals)} USDC of allowance is left.`;
  }
  if (account.amount < amount) return `${prefix} The owner's balance is too low.`;
  return prefix;
}
