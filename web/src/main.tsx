import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import { App } from "./App";
import { config } from "./config";

// Wallets implementing the Wallet Standard (Phantom, Solflare, Backpack…) are detected automatically.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectionProvider endpoint={config?.rpcUrl ?? "https://api.devnet.solana.com"} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </StrictMode>,
);
