// Grants the agent an allowance from the *test owner* keypair (CLI testing without a browser wallet).
// Usage: npm run approve -- <usdc amount>
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createApproveCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { requireState } from "../lib/config.js";
import { connection, explorerTx, loadKeypair, memoInstruction, toBaseUnits } from "../lib/solana.js";

const amount = process.argv[2];
if (!amount) {
  console.error("Usage: npm run approve -- <usdc amount>");
  process.exit(1);
}

const state = requireState();
const owner = loadKeypair("owner");
if (state.owner !== owner.publicKey.toBase58()) {
  console.error(`The agent spends from ${state.owner}, not the test owner. Use the dashboard, or run \`npm run fund -- test\` first.`);
  process.exit(1);
}
const mint = new PublicKey(state.mint);
const source = getAssociatedTokenAddressSync(mint, owner.publicKey);
const tx = new Transaction().add(
  createApproveCheckedInstruction(source, mint, new PublicKey(state.agent), owner.publicKey, toBaseUnits(amount, state.decimals), state.decimals),
  memoInstruction(`overseer: allowance set to ${amount} USDC`, owner.publicKey),
);
const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
console.log(`Agent allowance set to ${amount} USDC: ${explorerTx(sig)}`);
