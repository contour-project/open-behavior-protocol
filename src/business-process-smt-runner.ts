import type { BusinessProcess, ProcessReport, PropertyResult } from './business-process.ts';

// The existing synchronous checker also runs in the browser. The optional
// solver is started only inside the isolated Node checker worker and has a
// strict deadline; failure leaves the original, honest result unchanged.
export function addFractionalProofs(model:BusinessProcess,report:ProcessReport):ProcessReport {
  if(!report.properties.some(item=>item.status==='unknown') || !model.facts.some(item=>item.type==='decimal') && !JSON.stringify(model.properties).includes('"op":"decimal"'))return report;
  const runtime=(globalThis as {process?:NodeJS.Process}).process;if(!runtime?.getBuiltinModule)return report;
  const threads=runtime.getBuiltinModule('node:worker_threads');if(!threads || threads.isMainThread)return report;
  const pending=report.properties.filter(item=>item.status==='unknown').map(item=>item.id),buffer=new SharedArrayBuffer(8+262144),control=new Int32Array(buffer,0,2);
  const workerPath=import.meta.url.replace(/business-process-smt-runner\.(ts|js)$/, (_match,extension:string)=>`business-process-smt-worker.${extension}`);if(workerPath===import.meta.url)return report;
  let worker:InstanceType<typeof threads.Worker>|undefined;
  try {
    worker=new threads.Worker(new URL(workerPath),{workerData:{model,pending,buffer},resourceLimits:{maxOldGenerationSizeMb:128,stackSizeMb:4}});
    worker.on('error',()=>{});
    if(Atomics.wait(control,0,0,3500)==='timed-out' || Atomics.load(control,0)!==1)return report;
    const length=Atomics.load(control,1);if(length<=0 || length>buffer.byteLength-8)return report;
    const decoded=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,8,length))) as {properties?:PropertyResult[]};if(!Array.isArray(decoded.properties))return report;
    const proved=new Map(decoded.properties.filter(item=>item && pending.includes(item.id) && (item.proofMethod==='smt' && item.status==='verified' || item.proofMethod==='smt_conditional' && item.status==='unknown')).map(item=>[item.id,item]));
    if(!proved.size)return report;
    return {...report,scope:{...report.scope,semantics:`${report.scope.semantics} Дробные свойства дополнительно проверены SMT-решателем; условия и ограничения указаны в каждом результате.`},properties:report.properties.map(item=>proved.get(item.id) || item)};
  } catch {return report;}
  finally{if(worker)void worker.terminate().catch(()=>{});}
}
