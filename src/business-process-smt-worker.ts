import { workerData } from 'node:worker_threads';
import { proveFractionalProperties } from './business-process-smt.ts';
import type { BusinessProcess } from './business-process.ts';

const data=workerData as {model:BusinessProcess;pending:string[];buffer:SharedArrayBuffer};
const control=new Int32Array(data.buffer,0,2);
try {
  const properties=await proveFractionalProperties(data.model,data.pending),bytes=new TextEncoder().encode(JSON.stringify({properties}));
  if(bytes.length<=data.buffer.byteLength-8){new Uint8Array(data.buffer,8,bytes.length).set(bytes);Atomics.store(control,1,bytes.length);}
}catch{ /* The caller keeps the original unproven result. */ }
finally{Atomics.store(control,0,1);Atomics.notify(control,0);}
