#!/usr/bin/env node
'use strict';

const { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
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

function makeInstruction(parsedTx, sourceIx) {
  const accountMap = new Map(parsedTx.transaction.message.accountKeys.map(k => [k.pubkey.toBase58(), k]));
  const keys = sourceIx.accounts.map(pubkey => {
    const meta = accountMap.get(pubkey.toBase58());
    return {
      pubkey,
      isSigner: !!meta?.signer,
      isWritable: !!meta?.writable,
    };
  });
  return new TransactionInstruction({
    programId: PROGRAM,
    keys,
    data: Buffer.from(bs58.decode(sourceIx.data)),
  });
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

async function simulate(ix, label) {
  const tx = new Transaction();
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const signer = ix.keys.find(k => k.isSigner)?.pubkey;
  tx.feePayer = signer || SystemProgram.programId;
  tx.add(ix);
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
    const ix = tx.transaction.message.instructions.find(
      candidate => candidate.programId && candidate.programId.equals(PROGRAM) && candidate.accounts && candidate.data,
    );
    if (ix) {
      sample = { signature: item.signature, tx, ix };
      break;
    }
  }

  if (!sample) throw new Error('No recent PumpSwap transaction found for this pool');

  const baseIx = makeInstruction(sample.tx, sample.ix);
  const discriminator = baseIx.data.subarray(0, 8).toString('hex');
  const instruction = DISCRIMINATORS[discriminator] || 'unknown';
  const probes = [];

  probes.push(await simulate(baseIx, `baseline:${instruction}`));
  probes.push(await simulate(replacePair(baseIx, state.baseVault, state.quoteVault), 'vault-substitution'));
  probes.push(await simulate(replacePair(baseIx, state.baseMint, state.quoteMint), 'mint-substitution'));
  probes.push(await simulate(replaceOne(baseIx, POOL, SystemProgram.programId), 'pool-substitution'));

  if (baseIx.data.length >= 24 && ['buy', 'sell', 'withdraw'].includes(instruction)) {
    probes.push(await simulate(replaceU64(baseIx, 8, 0n), 'amount-zero'));
    probes.push(await simulate(replaceU64(baseIx, 8, 0xffffffffffffffffn), 'amount-max'));
    probes.push(await simulate(replaceU64(baseIx, 16, 0n), 'limit-zero'));
    probes.push(await simulate(replaceU64(baseIx, 16, 0xffffffffffffffffn), 'limit-max'));
  }

  const baseline = probes.find(p => p.label.startsWith('baseline:'));
  const suspicious = baseline?.succeeded ? probes.filter(p => !p.label.startsWith('baseline:') && p.succeeded) : [];
  const inconclusive = !baseline || !baseline.succeeded;

  const report = {
    pool: POOL.toBase58(),
    sampleSignature: sample.signature,
    instruction,
    discriminator,
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
