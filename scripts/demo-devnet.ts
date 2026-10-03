#!/usr/bin/env ts-node
import fs from "fs";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("3mmojyB5aYhqo1VXBYmE3tfUQfTuFkwfnHK4KZ1v66PK");
const FEE_BPS = 30;
const DECIMALS = 6;

function loadKeypair(p: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const keypairPath =
    process.env.SOLANA_KEYPAIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || "", ".config/solana/id.json");
  const payer = loadKeypair(keypairPath);
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "app", "src", "idl", "amm.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  idl.address = PROGRAM_ID.toBase58();
  const program = new Program(idl, provider);

  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(payer.publicKey)) / 1e9, "SOL");
  console.log("Program:", PROGRAM_ID.toBase58());

  const mintA = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
  const mintB = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
  console.log("Mint A:", mintA.toBase58());
  console.log("Mint B:", mintB.toBase58());

  const userAtaA = await createAssociatedTokenAccount(connection, payer, mintA, payer.publicKey);
  const userAtaB = await createAssociatedTokenAccount(connection, payer, mintB, payer.publicKey);
  await mintTo(connection, payer, mintA, userAtaA, payer, 1_000_000_000_000n);
  await mintTo(connection, payer, mintB, userAtaB, payer, 1_000_000_000_000n);

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
    PROGRAM_ID
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), pool.toBuffer()],
    PROGRAM_ID
  );
  const vaultA = getAssociatedTokenAddressSync(mintA, pool, true);
  const vaultB = getAssociatedTokenAddressSync(mintB, pool, true);
  const lpLock = getAssociatedTokenAddressSync(lpMint, pool, true);

  const initSig = await program.methods
    .initialize(FEE_BPS)
    .accounts({
      payer: payer.publicKey,
      tokenAMint: mintA,
      tokenBMint: mintB,
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
  console.log("Initialize:", initSig);

  const userLp = await createAssociatedTokenAccount(connection, payer, lpMint, payer.publicKey);
  const amountA = new BN(1_000_000_000);
  const amountB = new BN(1_000_000_000);

  const addSig = await program.methods
    .addLiquidity(amountA, amountB, new BN(0))
    .accounts({
      user: payer.publicKey,
      pool,
      vaultA,
      vaultB,
      lpMint,
      userTokenA: userAtaA,
      userTokenB: userAtaB,
      userLp,
      lpLock,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("Add liquidity:", addSig);

  const swapSig = await program.methods
    .swap(new BN(10_000_000), new BN(1), true)
    .accounts({
      user: payer.publicKey,
      pool,
      vaultA,
      vaultB,
      userTokenA: userAtaA,
      userTokenB: userAtaB,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("Swap:", swapSig);

  const vaultAAcc = await getAccount(connection, vaultA);
  const vaultBAcc = await getAccount(connection, vaultB);

  const deployment = {
    cluster: "devnet",
    programId: PROGRAM_ID.toBase58(),
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    pool: pool.toBase58(),
    lpMint: lpMint.toBase58(),
    payer: payer.publicKey.toBase58(),
    reserves: {
      a: vaultAAcc.amount.toString(),
      b: vaultBAcc.amount.toString(),
    },
    transactions: {
      initialize: initSig,
      addLiquidity: addSig,
      swap: swapSig,
    },
    explorer: {
      initialize: `https://explorer.solana.com/tx/${initSig}?cluster=devnet`,
      addLiquidity: `https://explorer.solana.com/tx/${addSig}?cluster=devnet`,
      swap: `https://explorer.solana.com/tx/${swapSig}?cluster=devnet`,
      program: `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`,
    },
    createdAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "devnet.json"), JSON.stringify(deployment, null, 2));

  const configPath = path.join(__dirname, "..", "app", "src", "config.ts");
  fs.writeFileSync(
    configPath,
    `export const CONFIG = {
  programId: "${deployment.programId}",
  rpcUrl: "https://api.devnet.solana.com",
  feeBps: 30,
  mintA: "${deployment.mintA}",
  mintB: "${deployment.mintB}",
  pool: "${deployment.pool}",
};
`
  );

  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
