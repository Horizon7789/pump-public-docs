#!/usr/bin/env node
'use strict';

const {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} = require('@solana/web3.js');
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rpc(method, params, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after') || 0);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));
        continue;
      }
      const body = await response.json();
      if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(750 * (attempt + 1));
    }
  }
  throw lastError || new Error(`${method} failed`);
}

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
  if (data.length < offset + 8) return ix;
  data.writeBigUInt64LE(BigInt(value), offset);
  return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
}

async function loadRawTransaction(signature) {
  const result = await rpc('getTransaction', [signature, {
    encoding: 'base64',
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  }]);
  if (!result) return null;
  const raw = result.transaction?.[0];
  if (!raw) throw new Error(`Missing raw transaction bytes for ${signature}`);
  return {
    tx: result,
    versioned: VersionedTransaction.deserialize(Buffer.from(raw, 'base64')),
  };
}

async function getLookupTables(versioned) {
  const lookups = versioned.message.addressTableLookups || [];
  if (lookups.length === 0) return [];
  const tables = [];
  for (const lookup of lookups) {
    const table = (await connection.getAddressLookupTable(lookup.accountKey, 'confirmed')).value;
    if (!table) throw new Error(`Unable to resolve lookup table ${lookup.accountKey.toBase58()}`);
    tables.push(table);
    await sleep(150);
  }
  return tables;
}

function decompile(versioned, lookupTables) {
  return TransactionMessage.decompile(versioned.message, {
    addressLookupTableAccounts: lookupTables,
  });
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
  const signatures = await rpc('getSignaturesForAddress', [POOL.toBase58(), { limit: 25, commitment: 'confirmed' }]);
  let sample = null;
  const candidateErrors = [];

  for (const item of signatures) {
    if (item.err) continue;
    try {
      const loaded = await loadRawTransaction(item.signature);
      if (!loaded) continue;
      const lookupTables = await getLookupTables(loaded.versioned);
      const message = decompile(loaded.versioned, lookupTables);
      const pumpIndex = findPumpSwapIndex(message.instructions);
      if (pumpIndex < 0) continue;

      const baseline = await simulateContext(message.instructions, message.payerKey, lookupTables, 'candidate-baseline');
      if (!baseline.succeeded) {
        candidateErrors.push({ signature: item.signature, err: baseline.err });
        continue;
      }

      sample = {
        signature: item.signature,
        instructions: message.instructions,
        pumpIndex,
        payer: message.payerKey,
        lookupTables,
        baseline,
      };
      break;
    } catch (error) {
      candidateErrors.push({ signature: item.signature, error: String(error.message || error) });
    }
    await sleep(250);
  }

  if (!sample) {
    const report = {
      pool: POOL.toBase58(),
      candidatesChecked: signatures.length,
      inconclusive: true,
      reason: 'No recent PumpSwap transaction could be replayed successfully at current state.',
      candidateErrors,
      safety: 'Simulation only. No transaction is broadcast or persisted.',
    };
    fs.writeFileSync('transaction-probe-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.error('INCONCLUSIVE: no current-state replayable historical PumpSwap transaction found.');
    process.exit(0);
  }

  const baseIx = sample.instructions[sample.pumpIndex];
  const discriminator = baseIx.data.subarray(0, 8).toString('hex');
  const instruction = DISCRIMINATORS[discriminator] || 'unknown';
  const probes = [sample.baseline];

  const mutate = async (label, mutation) => {
    const instructions = sample.instructions.map((ix, index) => index === sample.pumpIndex ? mutation(ix) : ix);
    probes.push(await simulateContext(instructions, sample.payer, sample.lookupTables, label));
    await sleep(200);
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

  const suspicious = probes.filter(p => p.label !== 'candidate-baseline' && p.succeeded);
  const report = {
    pool: POOL.toBase58(),
    sampleSignature: sample.signature,
    instruction,
    discriminator,
    originalInstructionCount: sample.instructions.length,
    targetInstructionIndex: sample.pumpIndex,
    addressLookupTables: sample.lookupTables.length,
    baselineSucceeded: sample.baseline.succeeded,
    inconclusive: false,
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

  console.log('PASS: all mutation probes were rejected by the current program state.');
})().catch(error => {
  console.error(`PROBE ERROR: ${error.stack || error}`);
  process.exit(1);
});
