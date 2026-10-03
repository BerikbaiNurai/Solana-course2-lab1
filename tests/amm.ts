import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { Amm } from "../target/types/amm";

describe("amm", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Amm as Program<Amm>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let pool: PublicKey;
  let lpMint: PublicKey;
  let vaultA: PublicKey;
  let vaultB: PublicKey;
  let lpLock: PublicKey;
  let userAtaA: PublicKey;
  let userAtaB: PublicKey;
  let userLp: PublicKey;

  const FEE_BPS = 30;
  const DECIMALS = 6;
  const ui = (n: number) => new BN(n * 10 ** DECIMALS);

  before(async () => {
    mintA = await createMint(provider.connection, payer, payer.publicKey, null, DECIMALS);
    mintB = await createMint(provider.connection, payer, payer.publicKey, null, DECIMALS);

    [pool] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
      program.programId
    );
    [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), pool.toBuffer()],
      program.programId
    );
    vaultA = getAssociatedTokenAddressSync(mintA, pool, true);
    vaultB = getAssociatedTokenAddressSync(mintB, pool, true);
    lpLock = getAssociatedTokenAddressSync(lpMint, pool, true);

    userAtaA = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mintA,
      payer.publicKey
    );
    userAtaB = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mintB,
      payer.publicKey
    );

    await mintTo(provider.connection, payer, mintA, userAtaA, payer, 1_000_000_000_000);
    await mintTo(provider.connection, payer, mintB, userAtaB, payer, 1_000_000_000_000);
  });

  it("initializes a pool", async () => {
    await program.methods
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

    const poolAccount = await program.account.pool.fetch(pool);
    expect(poolAccount.feeBps).to.equal(FEE_BPS);
    expect(poolAccount.tokenAMint.toBase58()).to.equal(mintA.toBase58());
    expect(poolAccount.tokenBMint.toBase58()).to.equal(mintB.toBase58());

    userLp = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      lpMint,
      payer.publicKey
    );
  });

  it("adds initial liquidity and locks minimum LP", async () => {
    const amountA = ui(1000);
    const amountB = ui(1000);

    await program.methods
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

    const vaultAAcc = await getAccount(provider.connection, vaultA);
    const vaultBAcc = await getAccount(provider.connection, vaultB);
    const lockAcc = await getAccount(provider.connection, lpLock);
    const userLpAcc = await getAccount(provider.connection, userLp);

    expect(Number(vaultAAcc.amount)).to.equal(amountA.toNumber());
    expect(Number(vaultBAcc.amount)).to.equal(amountB.toNumber());
    expect(Number(lockAcc.amount)).to.equal(1000);
    expect(Number(userLpAcc.amount)).to.be.greaterThan(0);

    const poolAccount = await program.account.pool.fetch(pool);
    expect(poolAccount.lockedLiquidity).to.equal(true);
  });

  it("swaps A -> B with fee applied", async () => {
    const amountIn = ui(10);
    const vaultBBefore = await getAccount(provider.connection, vaultB);
    const userBBefore = await getAccount(provider.connection, userAtaB);

    await program.methods
      .swap(amountIn, new BN(1), true)
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

    const vaultBAfter = await getAccount(provider.connection, vaultB);
    const userBAfter = await getAccount(provider.connection, userAtaB);

    expect(Number(vaultBAfter.amount)).to.be.lessThan(Number(vaultBBefore.amount));
    expect(Number(userBAfter.amount)).to.be.greaterThan(Number(userBBefore.amount));
  });

  it("removes liquidity and returns both tokens", async () => {
    const userLpAcc = await getAccount(provider.connection, userLp);
    const burnAmount = new BN(Number(userLpAcc.amount) / 2);
    const userABefore = await getAccount(provider.connection, userAtaA);
    const userBBefore = await getAccount(provider.connection, userAtaB);

    await program.methods
      .removeLiquidity(burnAmount, new BN(1), new BN(1))
      .accounts({
        user: payer.publicKey,
        pool,
        vaultA,
        vaultB,
        lpMint,
        userTokenA: userAtaA,
        userTokenB: userAtaB,
        userLp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userAAfter = await getAccount(provider.connection, userAtaA);
    const userBAfter = await getAccount(provider.connection, userAtaB);
    expect(Number(userAAfter.amount)).to.be.greaterThan(Number(userABefore.amount));
    expect(Number(userBAfter.amount)).to.be.greaterThan(Number(userBBefore.amount));
  });

  it("rejects zero-amount swap (negative)", async () => {
    try {
      await program.methods
        .swap(new BN(0), new BN(0), true)
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
      expect.fail("should have thrown");
    } catch (err: any) {
      const msg = err.toString();
      expect(msg).to.match(/ZeroAmount|Error/);
    }
  });

  it("rejects swap when slippage is too tight (negative)", async () => {
    try {
      await program.methods
        .swap(ui(5), ui(1_000_000), true)
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
      expect.fail("should have thrown");
    } catch (err: any) {
      const msg = err.toString();
      expect(msg).to.match(/SlippageExceeded|Error|custom program error/i);
    }
  });

  it("rejects initialize with identical mints (negative)", async () => {
    const [badPool] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintA.toBuffer(), mintA.toBuffer()],
      program.programId
    );
    const [badLp] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), badPool.toBuffer()],
      program.programId
    );
    const badVaultA = getAssociatedTokenAddressSync(mintA, badPool, true);
    const badVaultB = getAssociatedTokenAddressSync(mintA, badPool, true);
    const badLock = getAssociatedTokenAddressSync(badLp, badPool, true);

    try {
      await program.methods
        .initialize(FEE_BPS)
        .accounts({
          payer: payer.publicKey,
          tokenAMint: mintA,
          tokenBMint: mintA,
          pool: badPool,
          lpMint: badLp,
          vaultA: badVaultA,
          vaultB: badVaultB,
          lpLock: badLock,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/IdenticalMints|Error|custom program error/i);
    }
  });

  it("rejects fee above maximum (negative)", async () => {
    const mintC = await createMint(provider.connection, payer, payer.publicKey, null, DECIMALS);
    const mintD = await createMint(provider.connection, payer, payer.publicKey, null, DECIMALS);
    const [p] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintC.toBuffer(), mintD.toBuffer()],
      program.programId
    );
    const [lpm] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), p.toBuffer()],
      program.programId
    );
    try {
      await program.methods
        .initialize(500)
        .accounts({
          payer: payer.publicKey,
          tokenAMint: mintC,
          tokenBMint: mintD,
          pool: p,
          lpMint: lpm,
          vaultA: getAssociatedTokenAddressSync(mintC, p, true),
          vaultB: getAssociatedTokenAddressSync(mintD, p, true),
          lpLock: getAssociatedTokenAddressSync(lpm, p, true),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/FeeTooHigh|Error|custom program error/i);
    }
  });
});
