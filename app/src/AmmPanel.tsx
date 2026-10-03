import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import idl from "./idl/amm.json";
import { CONFIG } from "./config";

type Tab = "liquidity" | "swap" | "setup";
type TxStatus = { kind: "idle" | "pending" | "ok" | "err"; text: string };

const PROGRAM_ID = new PublicKey(CONFIG.programId);

function uiAmount(raw: bigint | number, decimals = 6): string {
  const n = typeof raw === "bigint" ? Number(raw) : raw;
  return (n / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function AmmPanel() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>("setup");
  const [status, setStatus] = useState<TxStatus>({ kind: "idle", text: "Подключите кошелёк Devnet." });
  const [mintA, setMintA] = useState(CONFIG.mintA);
  const [mintB, setMintB] = useState(CONFIG.mintB);
  const [amountA, setAmountA] = useState("100");
  const [amountB, setAmountB] = useState("100");
  const [swapIn, setSwapIn] = useState("5");
  const [aToB, setAToB] = useState(true);
  const [lpBurn, setLpBurn] = useState("10");
  const [reserves, setReserves] = useState({ a: 0n, b: 0n, lp: 0n });

  const provider = useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    return new AnchorProvider(connection, wallet as any, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
  }, [connection, wallet]);

  const program = useMemo(() => {
    if (!provider) return null;
    return new Program(idl as anchor.Idl, provider);
  }, [provider]);

  const poolPda = useMemo(() => {
    try {
      if (!mintA || !mintB) return null;
      const a = new PublicKey(mintA);
      const b = new PublicKey(mintB);
      const [pool] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), a.toBuffer(), b.toBuffer()],
        PROGRAM_ID
      );
      return pool;
    } catch {
      return null;
    }
  }, [mintA, mintB]);

  const refreshReserves = useCallback(async () => {
    if (!poolPda || !mintA || !mintB) return;
    try {
      const a = new PublicKey(mintA);
      const b = new PublicKey(mintB);
      const vaultA = getAssociatedTokenAddressSync(a, poolPda, true);
      const vaultB = getAssociatedTokenAddressSync(b, poolPda, true);
      const [lpMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_mint"), poolPda.toBuffer()],
        PROGRAM_ID
      );
      const [va, vb, mint] = await Promise.all([
        getAccount(connection, vaultA).catch(() => null),
        getAccount(connection, vaultB).catch(() => null),
        getMint(connection, lpMint).catch(() => null),
      ]);
      setReserves({
        a: va?.amount ?? 0n,
        b: vb?.amount ?? 0n,
        lp: mint ? BigInt(mint.supply.toString()) : 0n,
      });
    } catch {
    }
  }, [connection, poolPda, mintA, mintB]);

  useEffect(() => {
    refreshReserves();
    const t = setInterval(refreshReserves, 12_000);
    return () => clearInterval(t);
  }, [refreshReserves]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setStatus({ kind: "pending", text: `${label}… подпись и отправка в Devnet` });
    try {
      const sig = await fn();
      setStatus({
        kind: "ok",
        text: `${label} успешно. Tx: ${sig}`,
      });
      await refreshReserves();
    } catch (e: any) {
      const msg = e?.message || String(e);
      setStatus({ kind: "err", text: `${label} ошибка: ${msg}` });
    }
  };

  const ensureAta = async (mint: PublicKey, owner: PublicKey, payer: PublicKey) => {
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      const ix = createAssociatedTokenAccountInstruction(payer, ata, owner, mint);
      const tx = new Transaction().add(ix);
      const sig = await (wallet as any).sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
    }
    return ata;
  };

  const onInitialize = () =>
    run("Initialize pool", async () => {
      if (!program || !wallet.publicKey) throw new Error("Нет провайдера");
      const a = new PublicKey(mintA);
      const b = new PublicKey(mintB);
      const pool = poolPda!;
      const [lpMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_mint"), pool.toBuffer()],
        PROGRAM_ID
      );
      const vaultA = getAssociatedTokenAddressSync(a, pool, true);
      const vaultB = getAssociatedTokenAddressSync(b, pool, true);
      const lpLock = getAssociatedTokenAddressSync(lpMint, pool, true);

      const sig = await program.methods
        .initialize(CONFIG.feeBps)
        .accounts({
          payer: wallet.publicKey,
          tokenAMint: a,
          tokenBMint: b,
          pool,
          lpMint,
          vaultA,
          vaultB,
          lpLock,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      return sig;
    });

  const onAddLiquidity = () =>
    run("Add liquidity", async () => {
      if (!program || !wallet.publicKey || !poolPda) throw new Error("Нет провайдера / pool");
      const a = new PublicKey(mintA);
      const b = new PublicKey(mintB);
      const [lpMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_mint"), poolPda.toBuffer()],
        PROGRAM_ID
      );
      const userTokenA = await ensureAta(a, wallet.publicKey, wallet.publicKey);
      const userTokenB = await ensureAta(b, wallet.publicKey, wallet.publicKey);
      const userLp = await ensureAta(lpMint, wallet.publicKey, wallet.publicKey);
      const lpLock = getAssociatedTokenAddressSync(lpMint, poolPda, true);
      const amountABn = new BN(Math.floor(parseFloat(amountA) * 1e6));
      const amountBBn = new BN(Math.floor(parseFloat(amountB) * 1e6));

      return program.methods
        .addLiquidity(amountABn, amountBBn, new BN(0))
        .accounts({
          user: wallet.publicKey,
          pool: poolPda,
          vaultA: getAssociatedTokenAddressSync(a, poolPda, true),
          vaultB: getAssociatedTokenAddressSync(b, poolPda, true),
          lpMint,
          userTokenA,
          userTokenB,
          userLp,
          lpLock,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    });

  const onRemoveLiquidity = () =>
    run("Remove liquidity", async () => {
      if (!program || !wallet.publicKey || !poolPda) throw new Error("Нет провайдера / pool");
      const a = new PublicKey(mintA);
      const b = new PublicKey(mintB);
      const [lpMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_mint"), poolPda.toBuffer()],
        PROGRAM_ID
      );
      const userTokenA = await ensureAta(a, wallet.publicKey, wallet.publicKey);
      const userTokenB = await ensureAta(b, wallet.publicKey, wallet.publicKey);
      const userLp = await ensureAta(lpMint, wallet.publicKey, wallet.publicKey);
      const lpAmount = new BN(Math.floor(parseFloat(lpBurn) * 1e6));

      return program.methods
        .removeLiquidity(lpAmount, new BN(1), new BN(1))
        .accounts({
          user: wallet.publicKey,
          pool: poolPda,
          vaultA: getAssociatedTokenAddressSync(a, poolPda, true),
          vaultB: getAssociatedTokenAddressSync(b, poolPda, true),
          lpMint,
          userTokenA,
          userTokenB,
          userLp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    });

  const onSwap = () =>
    run("Swap", async () => {
      if (!program || !wallet.publicKey || !poolPda) throw new Error("Нет провайдера / pool");
      const a = new PublicKey(mintA);
      const b = new PublicKey(mintB);
      const userTokenA = await ensureAta(a, wallet.publicKey, wallet.publicKey);
      const userTokenB = await ensureAta(b, wallet.publicKey, wallet.publicKey);
      const amountIn = new BN(Math.floor(parseFloat(swapIn) * 1e6));

      return program.methods
        .swap(amountIn, new BN(1), aToB)
        .accounts({
          user: wallet.publicKey,
          pool: poolPda,
          vaultA: getAssociatedTokenAddressSync(a, poolPda, true),
          vaultB: getAssociatedTokenAddressSync(b, poolPda, true),
          userTokenA,
          userTokenB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    });

  const explorerTx =
    status.kind === "ok" && status.text.includes("Tx: ")
      ? `https://explorer.solana.com/tx/${status.text.split("Tx: ").pop()}?cluster=devnet`
      : null;

  return (
    <>
      <div className="panel">
        <div className="stats">
          <div className="stat">
            <span>Reserve A</span>
            <strong>{uiAmount(reserves.a)}</strong>
          </div>
          <div className="stat">
            <span>Reserve B</span>
            <strong>{uiAmount(reserves.b)}</strong>
          </div>
          <div className="stat">
            <span>LP supply</span>
            <strong>{uiAmount(reserves.lp)}</strong>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="tabs">
          <button className={`tab ${tab === "setup" ? "active" : ""}`} onClick={() => setTab("setup")}>
            Setup
          </button>
          <button
            className={`tab ${tab === "liquidity" ? "active" : ""}`}
            onClick={() => setTab("liquidity")}
          >
            Liquidity
          </button>
          <button className={`tab ${tab === "swap" ? "active" : ""}`} onClick={() => setTab("swap")}>
            Swap
          </button>
        </div>

        {tab === "setup" && (
          <>
            <div className="field">
              <label>Mint A</label>
              <input value={mintA} onChange={(e) => setMintA(e.target.value.trim())} placeholder="Base58 mint A" />
            </div>
            <div className="field">
              <label>Mint B</label>
              <input value={mintB} onChange={(e) => setMintB(e.target.value.trim())} placeholder="Base58 mint B" />
            </div>
            <p className="mono" style={{ color: "var(--muted)", marginTop: 0 }}>
              Pool PDA: {poolPda?.toBase58() ?? "—"}
            </p>
            <button className="btn" disabled={!wallet.connected || !mintA || !mintB} onClick={onInitialize}>
              Initialize pool
            </button>
            <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
              Demo-токены: <code>npm run setup:devnet</code> в корне репозитория (создаёт mint’ы, airdrop и обновляет
              config).
            </p>
          </>
        )}

        {tab === "liquidity" && (
          <>
            <div className="row">
              <div className="field">
                <label>Amount A</label>
                <input value={amountA} onChange={(e) => setAmountA(e.target.value)} />
              </div>
              <div className="field">
                <label>Amount B</label>
                <input value={amountB} onChange={(e) => setAmountB(e.target.value)} />
              </div>
            </div>
            <button className="btn" disabled={!wallet.connected} onClick={onAddLiquidity}>
              Add liquidity
            </button>
            <div className="field" style={{ marginTop: 16 }}>
              <label>LP to burn (remove)</label>
              <input value={lpBurn} onChange={(e) => setLpBurn(e.target.value)} />
            </div>
            <button className="btn" disabled={!wallet.connected} onClick={onRemoveLiquidity}>
              Remove liquidity
            </button>
          </>
        )}

        {tab === "swap" && (
          <>
            <div className="field">
              <label>Amount in</label>
              <input value={swapIn} onChange={(e) => setSwapIn(e.target.value)} />
            </div>
            <div className="field">
              <label>Direction</label>
              <select value={aToB ? "ab" : "ba"} onChange={(e) => setAToB(e.target.value === "ab")}>
                <option value="ab">A → B</option>
                <option value="ba">B → A</option>
              </select>
            </div>
            <button className="btn" disabled={!wallet.connected} onClick={onSwap}>
              Swap
            </button>
          </>
        )}

        {status.kind !== "idle" && (
          <div className={`status ${status.kind}`}>
            {status.text}
            {explorerTx && (
              <>
                <br />
                <a href={explorerTx} target="_blank" rel="noreferrer">
                  Открыть в Solana Explorer
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
