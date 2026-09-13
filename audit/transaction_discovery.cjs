#!/usr/bin/env node
'use strict';
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const POOL = new PublicKey(process.env.POOL);
const PROGRAM = new PublicKey(process.env.PUMPSWAP_PROGRAM);
const connection = new Connection(RPC, 'confirmed');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params, attempts=5) {
  let last;
  for(let i=0;i<attempts;i++) {
    try {
      const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params})});
      if(r.status===429||r.status>=500){await sleep(1000*(i+1));continue;}
      const b=await r.json(); if(b.error) throw new Error(JSON.stringify(b.error)); return b.result;
    } catch(e){last=e;if(i+1<attempts) await sleep(750*(i+1));}
  }
  throw last;
}
const names={
  '66063d1201daebea':'buy',
  '33e685a4017f83ad':'sell',
  'b712469c946da122':'withdraw',
  '9e1e7b7a4d6b6f90':'deposit'
};
function keys(tx){
  const msg=tx.transaction.message;
  const staticKeys=(msg.accountKeys||[]).map(x=>typeof x==='string'?x:x.pubkey);
  const loaded=tx.meta?.loadedAddresses || {writable:[],readonly:[]};
  return staticKeys.concat(loaded.writable||[],loaded.readonly||[]);
}
function classify(data){const d=(data||'').slice(0,11);return {discriminator:d,name:names[d]||'unknown'};}
(async()=>{
  const sigs=await rpc('getSignaturesForAddress',[POOL.toBase58(),{limit:25,commitment:'confirmed'}]);
  const report={pool:POOL.toBase58(),program:PROGRAM.toBase58(),transactions:[],safety:'Read-only discovery. No transactions are constructed, signed, simulated, or broadcast.'};
  for(const s of sigs){
    if(s.err) continue;
    try{
      const tx=await rpc('getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
      if(!tx) continue;
      const allKeys=keys(tx);
      const top=[];
      for(const [index,ix] of (tx.transaction.message.instructions||[]).entries()){
        const pid=ix.programId || allKeys[ix.programIdIndex];
        if(pid!==PROGRAM.toBase58()) continue;
        const data=ix.data||'';
        const c=classify(data);
        const accounts=(ix.accounts||[]).map(a=>typeof a==='string'?a:allKeys[a]);
        top.push({index,...c,dataLength:data.length,accounts});
      }
      const inner=[];
      for(const group of (tx.meta?.innerInstructions||[])) for(const [index,ix] of group.instructions.entries()) {
        const pid=ix.programId || allKeys[ix.programIdIndex];
        if(pid===PROGRAM.toBase58()) inner.push({parentIndex:group.index,index,...classify(ix.data||''),dataLength:(ix.data||'').length,accounts:(ix.accounts||[]).map(a=>typeof a==='string'?a:allKeys[a])});
      }
      if(top.length||inner.length) report.transactions.push({signature:s.signature,slot:tx.slot,topLevel:top,inner});
    } catch(e){report.transactions.push({signature:s.signature,error:String(e.message||e)});}
    await sleep(250);
  }
  fs.writeFileSync('transaction-discovery-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})();
