#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { check, encodeCbor, format, inspect, verify } from '../src/index.ts';

function usage():never {
  console.error('Использование: obp check|inspect|verify|format файл.obp [--strict] [--process ID] [--cbor]');process.exit(2);
}
const [command,file,...args]=process.argv.slice(2);
if(!command || !file || !['check','inspect','verify','format'].includes(command))usage();
let strict=false,cbor=false,processId:string|undefined;
for(let index=0;index<args.length;index++){
  if(args[index]==='--strict' && command==='check')strict=true;
  else if(args[index]==='--cbor' && ['inspect','verify'].includes(command))cbor=true;
  else if(args[index]==='--process' && command==='verify' && args[index+1])processId=args[++index];
  else usage();
}
try {
  const source=readFileSync(file,'utf8'),result=check(source,{filename:file,strict});
  if(command==='check'){
    for(const item of result.diagnostics){const where=item.span?`:${item.span.start.line}:${item.span.start.column}`:'';console.error(`${file}${where}: ${item.severity}: ${item.message}`);}
    if(result.ok)console.log(`OBP 0.1: процессов ${result.document?.processes.length || 0}, ошибок нет.`);
    else process.exitCode=1;
  } else if(!result.ok || !result.document){
    for(const item of result.diagnostics)console.error(`${file}: ${item.severity}: ${item.message}`);process.exitCode=1;
  } else if(command==='inspect'){const value=inspect(result.document);if(cbor)process.stdout.write(encodeCbor(value));else console.log(JSON.stringify(value,null,2));}
  else if(command==='format')process.stdout.write(format(result.document));
  else {
    const ids=result.document.processes.map(item=>item.id),id=processId || (ids.length===1?ids[0]:undefined);
    if(!id)throw new Error(`Укажите --process: ${ids.join(', ')}`);
    const report=verify(result.document,id);if(cbor)process.stdout.write(encodeCbor(report));else console.log(JSON.stringify(report,null,2));
    if(report.properties.some(item=>item.status==='violated') || report.examples.some(item=>item.status==='failed') || report.issues.some(item=>['overlap','uncovered','deadlock'].includes(item.kind)))process.exitCode=1;
    else if(!report.complete || report.properties.some(item=>item.status==='unknown' || item.status==='not_applicable') || report.examples.some(item=>item.status==='unknown'))process.exitCode=2;
  }
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
