#!/usr/bin/env node
'use strict';

const { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } = require('@solana/web3.js');
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
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params}) });
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * (i + 1)); continue; }
      const b = await r.json();
      if (b.error) throw new Error(`${method}: ${JSON.stringify(b.error)}`);
      return b.result;
    } catch (e) { last = e; if (i + 1 < attempts) await sleep(750 * (i + 1)); }
  }
  throw last || new Error(`${method} failed`);
}
function poolPubkey(raw, offset) { return new PublicKey(raw.subarray(offset, offset + 32)); }
async function getPoolState() {
  const info = await connection.getAccountInfo(POOL, 'confirmed');
  if (!info) throw new Error('Pool account not found');
  return { baseMint: poolPubkey(info.data,43), quoteMint: poolPubkey(info.data,75), lpMint: poolPubkey(info.data,107), baseVault: poolPubkey(info.data,139), quoteVault: poolPubkey(info.data,171) };
}
function replacePair(ix, a, b) { return new TransactionInstruction({programId:ix.programId, keys:ix.keys.map(k=>({...k,pubkey:k.pubkey.equals(a)?b:k.pubkey.equals(b)?a:k.pubkey})), data:Buffer.from(ix.data)}); }
function replaceOne(ix, a, b) { return new TransactionInstruction({programId:ix.programId, keys:ix.keys.map(k=>({...k,pubkey:k.pubkey.equals(a)?b:k.pubkey})), data:Buffer.from(ix.data)}); }
function replaceU64(ix, offset, value) { if(ix.data.length < offset+8) return ix; const d=Buffer.from(ix.data); d.writeBigUInt64LE(BigInt(value),offset); return new TransactionInstruction({programId:ix.programId,keys:ix.keys,data:d}); }
async function loadRaw(signature) {
  const result = await rpc('getTransaction',[signature,{encoding:'base64',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
  if(!result) return null;
  const raw=result.transaction?.[0];
  if(!raw) throw new Error('missing raw transaction');
  return VersionedTransaction.deserialize(Buffer.from(raw,'base64'));
}
async function lookupTables(vtx) {
  const lookups=vtx.message.addressTableLookups||[]; const out=[];
  for(const l of lookups){ const t=(await connection.getAddressLookupTable(l.accountKey,'confirmed')).value; if(!t) throw new Error(`missing ALT ${l.accountKey}`); out.push(t); await sleep(100); }
  return out;
}
function decompile(vtx, tables) { return TransactionMessage.decompile(vtx.message,{addressLookupTableAccounts:tables}); }
function pumpIndex(ixs){ return ixs.findIndex(ix=>ix.programId.equals(PROGRAM)&&ix.data.length>=8&&DISCRIMINATORS[ix.data.subarray(0,8).toString('hex')]); }
async function simulate(ixs,payer,tables,label){
  const bh=await connection.getLatestBlockhash('confirmed');
  const msg=new TransactionMessage({payerKey:payer,recentBlockhash:bh.blockhash,instructions:ixs}).compileToV0Message(tables);
  const r=await connection.simulateTransaction(new VersionedTransaction(msg),{sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed'});
  return {label,succeeded:r.value.err===null,err:r.value.err,unitsConsumed:r.value.unitsConsumed||0,logs:r.value.logs||[]};
}
(async()=>{
  const state=await getPoolState();
  const sigs=await rpc('getSignaturesForAddress',[POOL.toBase58(),{limit:25,commitment:'confirmed'}]);
  const candidates=[];
  for(const item of sigs){
    if(item.err) continue;
    try{
      const vtx=await loadRaw(item.signature); if(!vtx) continue;
      const tables=await lookupTables(vtx); const msg=decompile(vtx,tables); const idx=pumpIndex(msg.instructions); if(idx<0) continue;
      candidates.push({signature:item.signature,instructions:msg.instructions,pumpIndex:idx,payer:msg.payerKey,tables});
    }catch(e){ candidates.push({signature:item.signature,error:String(e.message||e)}); }
    await sleep(150);
  }
  // Prefer a candidate whose original transaction is still replayable; if none is, report the exact failure.
  let sample=null; const errors=[];
  for(const c of candidates){ if(!c.instructions) continue; try{ const b=await simulate(c.instructions,c.payer,c.tables,'candidate-baseline'); if(b.succeeded){sample={...c,baseline:b};break;} errors.push({signature:c.signature,err:b.err}); }catch(e){errors.push({signature:c.signature,error:String(e.message||e)});} await sleep(150); }
  if(!sample){
    const report={pool:POOL.toBase58(),candidatesChecked:sigs.length,pumpCandidates:candidates.filter(c=>c.instructions).length,inconclusive:true,reason:'No current-state replayable historical PumpSwap transaction found.',candidateErrors:errors,safety:'Simulation only. No transaction is broadcast or persisted.'};
    fs.writeFileSync('transaction-probe-report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); process.exit(0);
  }
  const base=sample.instructions[sample.pumpIndex]; const disc=base.data.subarray(0,8).toString('hex'); const kind=DISCRIMINATORS[disc]; const probes=[sample.baseline];
  const mutate=async(label,fn)=>{ const ixs=sample.instructions.map((ix,i)=>i===sample.pumpIndex?fn(ix):ix); probes.push(await simulate(ixs,sample.payer,sample.tables,label)); await sleep(150); };
  await mutate('vault-substitution',ix=>replacePair(ix,state.baseVault,state.quoteVault));
  await mutate('mint-substitution',ix=>replacePair(ix,state.baseMint,state.quoteMint));
  await mutate('pool-substitution',ix=>replaceOne(ix,POOL,SystemProgram.programId));
  if(base.data.length>=24&&['buy','sell','withdraw'].includes(kind)){
    await mutate('amount-zero',ix=>replaceU64(ix,8,0n));
    await mutate('amount-max',ix=>replaceU64(ix,8,0xffffffffffffffffn));
    await mutate('limit-zero',ix=>replaceU64(ix,16,0n));
    await mutate('limit-max',ix=>replaceU64(ix,16,0xffffffffffffffffn));
  }
  const suspicious=probes.filter(p=>p.label!=='candidate-baseline'&&p.succeeded);
  const report={pool:POOL.toBase58(),sampleSignature:sample.signature,instruction:kind,discriminator:disc,originalInstructionCount:sample.instructions.length,targetInstructionIndex:sample.pumpIndex,addressLookupTables:sample.tables.length,baselineSucceeded:true,inconclusive:false,suspicious,probes,state:Object.fromEntries(Object.entries(state).map(([k,v])=>[k,v.toBase58()])),safety:'Simulation only. No transaction is broadcast or persisted.'};
  fs.writeFileSync('transaction-probe-report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
  if(suspicious.length) process.exit(2);
  console.log('PASS: all mutation probes were rejected by the current program state.');
})().catch(e=>{console.error(`PROBE ERROR: ${e.stack||e}`);process.exit(1);});
