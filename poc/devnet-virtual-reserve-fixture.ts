/**
 * Disposable devnet fixture for the PumpSwap virtual-reserve hypothesis.
 *
 * This script is intentionally write-protected:
 *   - without --execute it only validates configuration and prints a plan;
 *   - with --execute it creates a fresh Token-2022/WSOL pool, initializes boost,
 *     performs a boost operation, then submits a sell with min_quote_amount_out=0.
 *
 * Required:
 *   ANCHOR_WALLET=/path/to/creator.json
 *   BOOST_AUTHORITY_KEYPAIR=/path/to/boost-authority.json
 *
 * Optional:
 *   RPC_URL=https://api.devnet.solana.com
 *   BASE_IN=4000000000
 *   QUOTE_IN=1000000000
 *   BOOST_QUOTE_IN=100000000
 *   SELL_BASE_IN=100000000
 *
 * The boost authority must match GlobalConfig.boostAuthority and be funded on
 * devnet. The creator wallet must have enough SOL for minting, pool creation,
 * and rent. No mainnet endpoint is accepted.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import BN from "bn.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  mintTo,
} from "@solana/spl-token";
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  GLOBAL_CONFIG_PDA,
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  boostVaultAta,
  boostVaultAuthorityPda,
  getPumpAmmProgram,
} from "@pump-fun/pump-swap-sdk";

const DEVNET_RPC = "https://api.devnet.solana.com";
const COMMITMENT: Commitment = "confirmed";
const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
);

type JsonKeypair = number[];

function envNumber(name: string, fallback: number): BN {
  const value = process.env[name];
  if (!value) return new BN(fallback);
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return new BN(value);
}

function loadKeypair(file: string, label: string): Keypair {
  const resolved = path.resolve(file);
  const contents = JSON.parse(fs.readFileSync(resolved, "utf8")) as JsonKeypair;
  if (!Array.isArray(contents) || contents.length !== 64) {
    throw new Error(`${label} must contain a Solana 64-byte keypair array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(contents));
}

function uniqueSigners(...signers: Keypair[]): Keypair[] {
  const byAddress = new Map<string, Keypair>();
  for (const signer of signers) byAddress.set(signer.publicKey.toBase58(), signer);
  return [...byAddress.values()];
}

function tx(
  instructions: TransactionInstruction[],
  signers: Keypair[],
): { transaction: Transaction; signers: Keypair[] } {
  return {
    transaction: new Transaction().add(...instructions),
    signers: uniqueSigners(...signers),
  };
}

async function send(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  execute: boolean,
  label: string,
): Promise<string | null> {
  const prepared = tx(instructions, signers);
  if (!execute) {
    console.log(
      JSON.stringify(
        {
          action: "dry_run",
          label,
          instructionCount: instructions.length,
          signers: prepared.signers.map((signer) =>
            signer.publicKey.toBase58(),
          ),
        },
        null,
        2,
      ),
    );
    return null;
  }
  const signature = await sendAndConfirmTransaction(
    connection,
    prepared.transaction,
    prepared.signers,
    { commitment: COMMITMENT },
  );
  console.log(JSON.stringify({ action: "sent", label, signature }, null, 2));
  return signature;
}

async function wrapSol(
  connection: Connection,
  payer: Keypair,
  owner: Keypair,
  lamports: BN,
  execute: boolean,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );
  const account = await connection.getAccountInfo(ata);
  const instructions: TransactionInstruction[] = [];
  if (account === null) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        ata,
        owner.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
      ),
    );
  }
  instructions.push(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: ata,
      lamports: lamports.toNumber(),
    }),
    createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
  );
  await send(connection, instructions, [payer, owner], execute, "wrap-devnet-sol");
  return ata;
}

async function buildInitBoostInstruction(
  connection: Connection,
  poolKey: PublicKey,
  creator: Keypair,
): Promise<TransactionInstruction> {
  const online = new OnlinePumpAmmSdk(connection);
  const pool = await online.fetchPool(poolKey);
  if (!pool.creator.equals(creator.publicKey)) {
    throw new Error(
      `creator mismatch: pool creator is ${pool.creator}, wallet is ${creator.publicKey}`,
    );
  }

  const quoteInfo = await connection.getAccountInfo(pool.quoteMint);
  if (quoteInfo === null) throw new Error("quote mint account not found");

  const boostAuthority = boostVaultAuthorityPda(poolKey);
  const boostVault = boostVaultAta(
    boostAuthority,
    pool.quoteMint,
    quoteInfo.owner,
  );
  const program = getPumpAmmProgram(connection);

  return program.methods
    .initBoost()
    .accountsPartial({
      pool: poolKey,
      globalConfig: GLOBAL_CONFIG_PDA,
      creator: creator.publicKey,
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      poolBaseTokenAccount: pool.poolBaseTokenAccount,
      poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
      boostVaultAuthority: boostAuthority,
      boostVault,
      quoteTokenProgram: quoteInfo.owner,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction();
}

async function createFreshPool(
  connection: Connection,
  creator: Keypair,
  baseIn: BN,
  quoteIn: BN,
  execute: boolean,
): Promise<{ poolKey: PublicKey; baseMint: PublicKey }> {
  const baseMint = await createMint(
    connection,
    creator,
    creator.publicKey,
    null,
    6,
    undefined,
    { commitment: COMMITMENT },
    TOKEN_2022_PROGRAM_ID,
  );
  const baseAta = await getOrCreateAssociatedTokenAccount(
    connection,
    creator,
    baseMint,
    creator.publicKey,
    false,
    COMMITMENT,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );

  // Keep base tokens in the creator wallet so the post-boost sell is funded.
  const totalBase = baseIn.add(envNumber("SELL_BASE_IN", 100_000_000)).add(baseIn);
  await mintTo(
    connection,
    creator,
    baseMint,
    baseAta.address,
    creator,
    BigInt(totalBase.toString()),
    [],
    { commitment: COMMITMENT },
    TOKEN_2022_PROGRAM_ID,
  );

  const online = new OnlinePumpAmmSdk(connection);
  const state = await online.createPoolSolanaState(
    0,
    creator.publicKey,
    baseMint,
    NATIVE_MINT,
    baseAta.address,
  );
  const instructions = await PUMP_AMM_SDK.createPoolInstructions(
    state,
    baseIn,
    quoteIn,
  );
  await send(connection, instructions, [creator], execute, "create-fresh-pool");
  return { poolKey: state.poolKey, baseMint };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      [
        "Usage: npm run devnet-fixture [-- --execute]",
        "",
        "Dry-run is the default. --execute creates a disposable devnet pool",
        "and submits the boost + sell transactions.",
        "",
        "Required environment:",
        "  ANCHOR_WALLET=/path/to/creator.json",
        "  BOOST_AUTHORITY_KEYPAIR=/path/to/boost-authority.json",
        "",
        "Optional environment:",
        "  RPC_URL=https://api.devnet.solana.com",
        "  BASE_IN=4000000000",
        "  QUOTE_IN=1000000000",
        "  BOOST_QUOTE_IN=100000000",
        "  SELL_BASE_IN=100000000",
      ].join("\n"),
    );
    return;
  }
  const execute = process.argv.includes("--execute");
  const rpcUrl = process.env.RPC_URL ?? DEVNET_RPC;
  if (!rpcUrl.includes("devnet")) {
    throw new Error("Safety stop: RPC_URL must be a Solana devnet endpoint");
  }

  const creatorPath = process.env.ANCHOR_WALLET;
  const boostAuthorityPath = process.env.BOOST_AUTHORITY_KEYPAIR;
  if (!creatorPath || !boostAuthorityPath) {
    throw new Error(
      "Set ANCHOR_WALLET and BOOST_AUTHORITY_KEYPAIR to keypair file paths",
    );
  }

  const creator = loadKeypair(creatorPath, "ANCHOR_WALLET");
  const boostAuthority = loadKeypair(
    boostAuthorityPath,
    "BOOST_AUTHORITY_KEYPAIR",
  );
  const connection = new Connection(rpcUrl, COMMITMENT);
  const baseIn = envNumber("BASE_IN", 4_000_000_000);
  const quoteIn = envNumber("QUOTE_IN", 1_000_000_000);
  const boostQuoteIn = envNumber("BOOST_QUOTE_IN", 100_000_000);
  const sellBaseIn = envNumber("SELL_BASE_IN", 100_000_000);

  const version = await connection.getVersion();
  const balance = await connection.getBalance(creator.publicKey, COMMITMENT);
  const boostBalance = await connection.getBalance(
    boostAuthority.publicKey,
    COMMITMENT,
  );
  console.log(
    JSON.stringify(
      {
        mode: execute ? "execute_devnet_fixture" : "dry_run_devnet_fixture",
        rpcUrl,
        solanaVersion: version,
        pumpAmmProgram: PUMP_AMM_PROGRAM_ID.toBase58(),
        creator: creator.publicKey.toBase58(),
        boostAuthority: boostAuthority.publicKey.toBase58(),
        creatorLamports: balance,
        boostAuthorityLamports: boostBalance,
        amounts: {
          baseIn: baseIn.toString(),
          quoteIn: quoteIn.toString(),
          boostQuoteIn: boostQuoteIn.toString(),
          sellBaseIn: sellBaseIn.toString(),
        },
      },
      null,
      2,
    ),
  );

  if (!execute) {
    console.log(
      "Dry run only. Add --execute to create the disposable pool and submit devnet transactions.",
    );
    return;
  }

  const { poolKey } = await createFreshPool(
    connection,
    creator,
    baseIn,
    quoteIn,
    execute,
  );
  console.log(JSON.stringify({ poolKey: poolKey.toBase58() }, null, 2));

  const initBoost = await buildInitBoostInstruction(
    connection,
    poolKey,
    creator,
  );
  await send(connection, [initBoost], [creator], execute, "init-boost");

  const online = new OnlinePumpAmmSdk(connection);
  const globalConfig = await online.fetchGlobalConfigAccount();
  if (!globalConfig.boostAuthority.equals(boostAuthority.publicKey)) {
    throw new Error(
      `BOOST_AUTHORITY_KEYPAIR does not match GlobalConfig.boostAuthority (${globalConfig.boostAuthority})`,
    );
  }
  if (!globalConfig.boostEnabled) {
    throw new Error(
      "GlobalConfig.boostEnabled is false; enable boost on devnet before running this fixture",
    );
  }

  const pool = await online.fetchPool(poolKey);
  const quoteInfo = await connection.getAccountInfo(pool.quoteMint);
  if (quoteInfo === null) throw new Error("quote mint account not found");
  await wrapSol(
    connection,
    boostAuthority,
    boostAuthority,
    boostQuoteIn,
    execute,
  );

  const boostIx = await online.boostBuyAndBurnInstruction(
    poolKey,
    boostAuthority.publicKey,
    boostQuoteIn,
    new BN(0),
  );
  await send(
    connection,
    [boostIx],
    [boostAuthority],
    execute,
    "boost-buy-and-burn",
  );

  const state = await online.swapSolanaState(
    poolKey,
    creator.publicKey,
  );
  const poolBeforeSell = state.pool;
  const effectiveQuote = state.poolQuoteAmount.add(
    poolBeforeSell.virtualQuoteReserves,
  );
  console.log(
    JSON.stringify(
      {
        postBoost: {
          poolQuoteAmount: state.poolQuoteAmount.toString(),
          virtualQuoteReserves:
            poolBeforeSell.virtualQuoteReserves.toString(),
          effectiveQuoteReserves: effectiveQuote.toString(),
          poolBaseAmount: state.poolBaseAmount.toString(),
        },
      },
      null,
      2,
    ),
  );

  // Deliberately bypass SDK preflight by setting minQuote=0. The deployed
  // program—not only the client quote helper—must enforce the settlement rule.
  const sellInstructions = await PUMP_AMM_SDK.sellInstructions(
    state,
    sellBaseIn,
    new BN(0),
  );
  try {
    await send(
      connection,
      sellInstructions,
      [creator],
      execute,
      "sell-with-zero-min-output",
    );
    console.log(
      JSON.stringify(
        {
          verdict:
            "TRANSACTION_SUCCEEDED_INSPECT_SETTLEMENT",
          detail:
            "The deployed sell accepted min_quote_amount_out=0. Compare pre/post quote balances and pool reserves before claiming impact.",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          verdict: "TRANSACTION_REJECTED",
          detail:
            "The deployed sell rejected the transaction. Inspect the error for InsufficientRealQuoteReserves; rejection is expected guard behavior, not an exploit.",
          error: String(error),
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});