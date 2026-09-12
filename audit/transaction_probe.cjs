#!/usr/bin/env node
'use strict';

const {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  AddressLookupTableAccount,
} = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const fs = require('fs');

const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const POOL = new PublicKey(process.env.POOL);
const PROGRAM = new PublicKey(process.env.PUMPSWAP_PROGRAM);
const connection = new Connection(RPC, 'confirmed');

const DISCRIMINATORS = {
  '66063d1201daebea': 'buy',
  '33e685a4017f83ad': 'sell',
  'b712469c946da122': 'withdraw',
};

function poolPubkey(raw, offset) {
  return new PublicKey(raw.subarray(offset, offset + 32));
}

async function getPoolState() {
  const info = await connection.getAccountInfo(POOL, 'confirmed');
  if (!info) throw new Error('Pool account not found');
  return {
    baseMint: poolPubkey(info.data, 43),
    quoteMint: poolPubkey(info.data, 75),
    lpMint: poolPubkey(info.data, 107),
    baseVault: poolPubkey(info.data, 139),
    quoteVault: poolPubkey(info.data, 171),
  };
}

function accountMeta(pubkey, writableSet, signerSet) {
  return {
    pubkey,
    isSigner: signerSet.has(pubkey.toBase58()),
    isWritable: writableSet.has(pubkey.toBase58()),
  };
}

function parsedInstructionToInstruction(parsedIx, accountMap) {
  const writable = new Set();
  const signers = new Set();
  for (const key of accountMap) {
    if (key.writable) writable.add(key.pubkey.toBase58());
    if (key.signer) signers.add(key.pubkey.toBase58());
  }

  const keys = parsedIx.accounts.map(pubkey => accountMeta(pubkey, writable, signers));
  return new TransactionInstruction({
    programId: parsedIx.programId,
    keys,
    data: Buffer.from(bs58.decode(parsedIx.data)),
  });
}

function parsedMessageInstructions(tx) {
  const accountMap = tx.transaction.message.accountKeys;
  return tx.transaction.message.instructions.map(ix =>
    parsedInstructionToInstruction(ix, accountMap),
  );
}

function replacePair(ix, a, b) {
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys.map(k => ({
      ...k,
      pubkey: k.pubkey.equals(a) ? b : k.pubkey.equals(b) ? a : k.pubkey,
    })),
    data: Buffer.from(ix.data),
  });
}

function replaceOne(ix, a, b) {
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys.map(k => ({ ...k, pubkey: k.pubkey.equals(a) ? b : k.pubkey })),
    data: Buffer.from(ix.data),
  });
}

function replaceU64(ix, offset, value) {
  const data = Buffer.from(ix.data);
  data.writeBigUInt64LE(BigInt(value), offset);
  return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
}

async function getLookupTables(tx) {
  const lookups = tx.transaction.message.addressTableLookups || [];
  if (lookups.length === 0) return [];
  const tables = await Promise.all(
    lookups.map(async lookup => {
      const result = await connection.getAddressLookupTable(lookup.accountKey, 'confirmed');
      return result.value;
    }),
  );
  if (tables.some(table => !table)) throw new Error('Unable to resolve one or more address lookup tables');
  return tables;
}

function findPumpSwapIndex(instructions) {
  return instructions.findIndex(ix => {
    if (!ix.programId.equals(PROGRAM) || ix.data.length < 8) return false;
    return Boolean(DISCRIMINATORS[ix.data.subarray(0, 8).toString('hex')]);
  });
}

async function simulateContext(instructions, payer, lookupTables, label) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(message);
  const result = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  });
  return {
    label,
    succeeded: result.value.err === null,
    err: result.value.err,
    unitsConsumed: result.value.unitsConsumed || 0,
    logs: result.value.logs || [],
  };
}

(async () => {
  const state = await getPoolState();
  const signatures = await connection.getSignaturesForAddress(POOL, { limit: 40 }, 'confirmed');
  let sample = null;

  for (const item of signatures) {
    if (item.err) continue;
    const tx = await connection.getParsedTransaction(item.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx) continue;
    const instructions = parsedMessageInstructions(tx);
    const pumpIndex = findPumpSwapIndex(instructions);
    if (pumpIndex >= 0) {
      sample = { signature: item.signature, tx, instructions, pumpIndex };
      break;
    }
  }

  if (!sample) throw new Error('No recent replayable PumpSwap transaction found for this pool');

  const baseIx = sample.instructions[sample.pumpIndex];
  const discriminator = baseIx.data.subarray(0, 8).toString('hex');
  const instruction = DISCRIMINATORS[discriminator] || 'unknown';
  const payer = sample.tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey;
  if (!payer) throw new Error('Historical transaction has no signer/fee payer');

  const lookupTables = await getLookupTables(sample.tx);
  const probes = [];

  probes.push(await simulateContext(sample.instructions, payer, lookupTables, `baseline:${instruction}`));

  const mutate = async (label, mutation) => {
    const instructions = sample.instructions.map((ix, index) =>
      index === sample.pumpIndex ? mutation(ix) : ix,
    );
    probes.push(await simulateContext(instructions, payer, lookupTables, label));
  };

  await mutate('vault-substitution', ix => replacePair(ix, state.baseVault, state.quoteVault));
  await mutate('mint-substitution', ix => replacePair(ix, state.baseMint, state.quoteMint));
  await mutate('pool-substitution', ix => replaceOne(ix, POOL, SystemProgram.programId));

  if (baseIx.data.length >= 24 && ['buy', 'sell', 'withdraw'].includes(instruction)) {
    await mutate('amount-zero', ix => replaceU64(ix, 8, 0n));
    await mutate('amount-max', ix => replaceU64(ix, 8, 0xffffffffffffffffn));
    await mutate('limit-zero', ix => replaceU64(ix, 16, 0n));
    await mutate('limit-max', ix => replaceU64(ix, 16, 0xffffffffffffffffn));
  }

  const baseline = probes.find(p => p.label.startsWith('baseline:'));
  const suspicious = baseline?.succeeded ? probes.filter(p => !p.label.startsWith('baseline:') && p.succeeded) : [];
  const inconclusive = !baseline || !baseline.succeeded;

  const report = {
    pool: POOL.toBase58(),
    sampleSignature: sample.signature,
    instruction,
    discriminator,
    originalInstructionCount: sample.instructions.length,
    targetInstructionIndex: sample.pumpIndex,
    addressLookupTables: lookupTables.length,
    baselineSucceeded: !!baseline?.succeeded,
    inconclusive,
    suspicious,
    probes,
    state: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.toBase58()])),
    safety: 'Simulation only. No transaction is broadcast or persisted.',
  };

  fs.writeFileSync('transaction-probe-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (suspicious.length > 0) {
    console.error(`FAIL: ${suspicious.length} mutation probe(s) unexpectedly succeeded.`);
    process.exit(2);
  }

  if (inconclusive) {
    console.error('INCONCLUSIVE: the selected historical transaction did not replay successfully at current state.');
    process.exit(0);
  }

  console.log('PASS: all mutation probes were rejected by the current program state.');
})();
