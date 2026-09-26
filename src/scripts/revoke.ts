// Revokes the agent's allowance from the *test owner* keypair.
import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createRevokeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { requireState } from "../lib/config.js";
import { connection, explorerTx, loadKeypair, memoInstruction } from "../lib/solana.js";

const state = requireState();
const owner = loadKeypair("owner");
const source = getAssociatedTokenAddressSync(new PublicKey(state.mint), owner.publicKey);
const tx = new Transaction().add(
  createRevokeInstruction(source, owner.publicKey),
  memoInstruction("overseer: allowance revoked", owner.publicKey),
);
const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
console.log(`Agent allowance revoked: ${explorerTx(sig)}`);
