#!/usr/bin/env ts-node
import fs from "fs";
import path from "path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

async function airdrop(connection: Connection, pubkey: PublicKey) {
  const sig = await connection.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function main() {
  const keypairPath =
    process.env.SOLANA_KEYPAIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || "", ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

  console.log("Payer:", payer.publicKey.toBase58());
  const bal = await connection.getBalance(payer.publicKey);
  if (bal < 0.5 * LAMPORTS_PER_SOL) {
    console.log("Requesting airdrop…");
    try {
      await airdrop(connection, payer.publicKey);
    } catch (e) {
      console.warn("Airdrop failed, try https://faucet.solana.com", e);
    }
  }

  const mintA = await createMint(connection, payer, payer.publicKey, null, 6);
  const mintB = await createMint(connection, payer, payer.publicKey, null, 6);
  const ataA = await createAssociatedTokenAccount(connection, payer, mintA, payer.publicKey);
  const ataB = await createAssociatedTokenAccount(connection, payer, mintB, payer.publicKey);
  await mintTo(connection, payer, mintA, ataA, payer, 1_000_000_000_000n);
  await mintTo(connection, payer, mintB, ataB, payer, 1_000_000_000_000n);

  const programId = new PublicKey(
    process.env.PROGRAM_ID || "3mmojyB5aYhqo1VXBYmE3tfUQfTuFkwfnHK4KZ1v66PK"
  );
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
    programId
  );

  const deployment = {
    cluster: "devnet",
    programId: programId.toBase58(),
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    pool: pool.toBase58(),
    payer: payer.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "devnet.json"), JSON.stringify(deployment, null, 2));

  const configPath = path.join(__dirname, "..", "app", "src", "config.ts");
  const configSrc = `export const CONFIG = {
  programId: "${deployment.programId}",
  rpcUrl: "https://api.devnet.solana.com",
  feeBps: 30,
  mintA: "${deployment.mintA}",
  mintB: "${deployment.mintB}",
  pool: "${deployment.pool}",
};
`;
  fs.writeFileSync(configPath, configSrc);

  console.log(JSON.stringify(deployment, null, 2));
  console.log("Updated", configPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
