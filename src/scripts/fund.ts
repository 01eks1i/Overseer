// Gives a wallet test USDC + a little SOL, and makes it the owner the agent spends from.
// Usage: npm run fund -- <wallet address | test> [usdc amount, default 50]
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { requireState, writeState } from "../lib/config.js";
import { connection, loadKeypair, toBaseUnits } from "../lib/solana.js";

const [target, amountArg = "50"] = process.argv.slice(2);
if (!target) {
  console.error("Usage: npm run fund -- <wallet address | test> [usdc amount]");
  process.exit(1);
}

const state = requireState();
const admin = loadKeypair("admin");
const mint = new PublicKey(state.mint);
const wallet = target === "test" ? loadKeypair("owner").publicKey : new PublicKey(target);

if ((await connection.getBalance(wallet)) < 0.02 * LAMPORTS_PER_SOL) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: wallet, lamports: 0.05 * LAMPORTS_PER_SOL }),
  );
  await sendAndConfirmTransaction(connection, tx, [admin]);
  console.log("Sent 0.05 SOL for fees");
}

const account = await getOrCreateAssociatedTokenAccount(connection, admin, mint, wallet);
if (Number(amountArg) > 0) {
  await mintTo(connection, admin, mint, account.address, admin, toBaseUnits(amountArg, state.decimals));
  console.log(`Minted ${amountArg} test USDC`);
}

writeState({ owner: wallet.toBase58() });
console.log(`The agent now spends from ${wallet.toBase58()} (token account ${account.address.toBase58()}).`);
console.log("Restart the MCP server / dashboard if they are running, so they pick up the new owner.");
