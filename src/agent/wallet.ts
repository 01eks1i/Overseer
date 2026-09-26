// The agent's side of Overseer / ApiSift. The agent never holds the owner's funds: it signs token transfers
// as the *delegate* of a token account, so the SPL Token program enforces the cap.
// With a project, the agent is that project's agent and spends from the project's budget account;
// without one, it is the original single agent spending from the owner's main token account.
import { LAMPORTS_PER_SOL, PublicKey, Transaction, type Keypair } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { requireState } from "../lib/config.js";
import { findProject } from "../lib/projects.js";
import { connection, describeTxError, explorerTx, fromBaseUnits, loadKeypair, memoInstruction, sendAndConfirm } from "../lib/solana.js";

interface Spender {
  agent: Keypair;
  owner: string;
  /** Token account the agent spends from as delegate. */
  source: PublicKey;
  project?: string;
}

function resolveSpender(project?: string): Spender {
  const state = requireState();
  if (project) {
    const found = findProject(project);
    if (!found) throw new Error(`No ApiSift project called "${project}"`);
    return { agent: loadKeypair(`agent-${found.id}`), owner: found.owner, source: new PublicKey(found.tokenAccount), project: found.id };
  }
  const mint = new PublicKey(state.mint);
  return { agent: loadKeypair("agent"), owner: state.owner, source: getAssociatedTokenAddressSync(mint, new PublicKey(state.owner)) };
}

export interface AllowanceStatus {
  project?: string;
  agent: string;
  owner: string;
  ownerTokenAccount: string;
  mint: string;
  ownerBalanceUsdc: string;
  allowanceUsdc: string;
  delegatedToAgent: boolean;
  agentSolForFees: number;
}

export async function getAllowance(project?: string): Promise<AllowanceStatus> {
  const state = requireState();
  const { agent, owner, source, project: projectId } = resolveSpender(project);
  const account = await getAccount(connection, source).catch(() => null);
  const delegatedToAgent = !!account?.delegate?.equals(agent.publicKey);
  return {
    project: projectId,
    agent: agent.publicKey.toBase58(),
    owner,
    ownerTokenAccount: source.toBase58(),
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
 * Pays `amount` base units to `destination` from the spending account, signing only as delegate.
 * There is deliberately no client-side allowance check: the transaction is always submitted, so an
 * overspend is rejected by the Token program itself and leaves a failed transaction on the explorer.
 */
export async function payFromAllowance(destination: PublicKey, amount: bigint, memo: string, project?: string): Promise<PaymentResult> {
  const state = requireState();
  const { agent, source } = resolveSpender(project);
  const mint = new PublicKey(state.mint);
  const amountUsdc = fromBaseUnits(amount, state.decimals);

  const tx = new Transaction().add(
    createTransferCheckedInstruction(source, mint, destination, agent.publicKey, amount, state.decimals),
    memoInstruction(memo.slice(0, 200)),
  );
  const { signature, err } = await sendAndConfirm(tx, [agent], { skipPreflight: true });
  if (!err) return { ok: true, signature, explorer: explorerTx(signature), amountUsdc };

  return {
    ok: false,
    reason: await explainRejection(source, agent.publicKey, amount, state.decimals, describeTxError(err)),
    signature,
    explorer: explorerTx(signature),
    amountUsdc,
  };
}

async function explainRejection(source: PublicKey, agent: PublicKey, amount: bigint, decimals: number, chainError: string): Promise<string> {
  const account = await getAccount(connection, source).catch(() => null);
  const prefix = `Rejected by the Solana Token program (${chainError}).`;
  if (!account) return `${prefix} The spending account doesn't exist.`;
  if (!account.delegate?.equals(agent)) return `${prefix} The owner has not granted this agent an allowance, or revoked it.`;
  if (account.delegatedAmount < amount) {
    return `${prefix} Allowance exceeded: this costs ${fromBaseUnits(amount, decimals)} USDC but only ${fromBaseUnits(account.delegatedAmount, decimals)} USDC of allowance is left.`;
  }
  if (account.amount < amount) return `${prefix} The budget account's balance is too low.`;
  return prefix;
}
