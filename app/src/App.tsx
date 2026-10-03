import { useMemo, useCallback } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";
import { AmmPanel } from "./AmmPanel";
import { CONFIG } from "./config";

export default function App() {
  const endpoint = useMemo(
    () => CONFIG.rpcUrl || clusterApiUrl("devnet"),
    []
  );
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  const onError = useCallback((e: Error) => {
    console.error(e);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>
          <div className="app">
            <header className="topbar">
              <div className="brand">
                <span className="badge">Solana Devnet</span>
                <h1>LeafSwap AMM</h1>
                <p>Constant-product пул · SPL Token · PDA vaults</p>
              </div>
              <WalletMultiButton />
            </header>

            <section className="hero">
              <h2>Обмен и ликвидность без кастодии</h2>
              <p>
                Добавляйте ликвидность, получайте LP-доли и меняйте токены по формуле
                x·y=k с комиссией {CONFIG.feeBps / 100}%. Средства хранятся в PDA-хранилищах
                программы.
              </p>
            </section>

            <AmmPanel />

            <footer className="footer">
              Program ID: <span className="mono">{CONFIG.programId}</span>
              <br />
              Только Devnet. Не используйте реальные средства / mainnet ключи.
            </footer>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
