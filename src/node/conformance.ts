import { spawn } from 'node:child_process';
import { validateExpressionValues, type AlgorithmValue } from '../business-algorithm.ts';
import { checkBusinessTrace, generateBusinessExamples, sameFactValue, validateBusinessProcess, type BusinessProcess, type Example, type GeneratedExamples } from '../business-process.ts';

export type ConformanceCase = {
  id:string;title:string;status:'passed'|'failed'|'unknown';detail:string;
  trace?:Omit<Example,'id'>;
};
export type ConformanceReport = {
  kind:'observed_examples';cases:ConformanceCase[];passed:number;failed:number;unknown:number;
  generation?:Omit<GeneratedExamples,'examples'>;
  totalCases:number;offset:number;remaining:number;
  note:string;
};
export type AdapterOptions = {command:string;args:string[];cwd:string;timeoutMs?:number;env?:NodeJS.ProcessEnv;includeTraces?:boolean;generate?:boolean;offset?:number;limit?:number};
type State=Record<string,AlgorithmValue>;
type Observation={caseId:string;initial:State;states:State[];final:State;completed:boolean};
const plain=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
const MAX_OUTPUT=262144;

function runAdapter(options:AdapterOptions,input:object):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    const timeout=Math.max(100,Math.min(options.timeoutMs || 10_000,60_000));
    // An adapter is arbitrary executable code. Do not pass the host's full
    // environment, which may contain secrets, unless the caller explicitly
    // supplies it. The caller chooses the command and needed variables.
    const environment=options.env ?? {PATH:process.env.PATH || '/usr/bin:/bin',LANG:'C.UTF-8'};
    const child=spawn(options.command,options.args,{cwd:options.cwd,env:environment,stdio:['pipe','pipe','pipe'],shell:false});
    const stdout:Buffer[]=[],stderr:Buffer[]=[];let length=0,settled=false;
    const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Адаптер не завершился вовремя'));},timeout);
    child.on('error',error=>finish(new Error(`Не удалось запустить адаптер: ${error.message}`)));
    child.stdin.on('error',()=>{});
    child.stdout.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>MAX_OUTPUT){child.kill('SIGKILL');finish(new Error('Адаптер вернул слишком много данных'));}else stdout.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{if(stderr.reduce((sum,item)=>sum+item.length,0)<4096)stderr.push(chunk.subarray(0,4096));});
    child.on('close',(code,signal)=>{
      if(code!==0){finish(new Error(`Адаптер завершился с ошибкой${signal?` (${signal})`:` (${code ?? 'нет кода'})`}`));return;}
      try{finish(undefined,JSON.parse(Buffer.concat(stdout).toString('utf8')));}catch{finish(new Error('Адаптер должен вернуть один JSON-объект'));}
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function state(value:unknown,model:BusinessProcess):State {
  if(!plain(value) || Object.keys(value).length!==model.facts.length || model.facts.some(fact=>!Object.hasOwn(value,fact.id)))throw new Error('Адаптер должен вернуть все значения модели без дополнительных полей');
  validateExpressionValues(model.facts,value as State);
  return value as State;
}
function observation(value:unknown,model:BusinessProcess,example:Example):Observation {
  if(!plain(value) || Object.keys(value).some(key=>!['caseId','initial','states','final','completed'].includes(key)) || value.caseId!==example.id || !Array.isArray(value.states) || value.states.length!==example.actions.length || typeof value.completed!=='boolean')throw new Error('Неполный или неверный ответ адаптера');
  return {caseId:example.id,initial:state(value.initial,model),states:value.states.map(item=>state(item,model)),final:state(value.final,model),completed:value.completed};
}
function difference(model:BusinessProcess,expected:State,actual:State):string|undefined {
  for(const fact of model.facts)if(Object.hasOwn(expected,fact.id) && !sameFactValue(fact,expected[fact.id]!,actual[fact.id]!))return fact.title;
}

// The adapter receives inputs and action ids only, never the expected answers.
// It must invoke the real implementation and return observed snapshots.
export async function checkImplementationExamples(value:unknown,options:AdapterOptions):Promise<ConformanceReport> {
  const model=validateBusinessProcess(value),cases:ConformanceCase[]=[];
  if(!options.command || !Array.isArray(options.args) || !options.cwd)throw new Error('Укажите команду, аргументы и рабочую папку адаптера');
  const offset=options.offset ?? 0,limit=options.limit ?? 64;if(!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>64)throw new Error('Некорректная страница примеров');
  const add=(example:Example,status:ConformanceCase['status'],detail:string,trace?:Omit<Example,'id'>)=>cases.push({id:example.id,title:example.title,status,detail,...(options.includeTraces && trace?{trace}:{})});
  const generated=options.generate?generateBusinessExamples(model):undefined,examples=[...model.examples,...(generated?.examples || [])];
  for(const example of examples.slice(offset,offset+limit)){
    if((model.instances || 1)>1){add(example,'unknown','Проверка адаптера для нескольких запусков пока не поддерживается');continue;}
    if(!example.actions.length){add(example,'unknown','Для проверки укажите хотя бы одно действие');continue;}
    const initial:State={};let missing='';
    for(const fact of model.facts){const supplied=example.initial[fact.id];if(supplied!==undefined)initial[fact.id]=supplied;else if(fact.initial.kind==='value')initial[fact.id]=fact.initial.value;else {missing=fact.title;break;}}
    if(missing){add(example,'unknown',`Не задано начальное значение «${missing}»`);continue;}
    let observed:Observation;
    try {observed=observation(await runAdapter(options,{caseId:example.id,initial,actions:example.actions}),model,example);}
    catch(error){add(example,'unknown',error instanceof Error?error.message:'Не удалось получить наблюдение');continue;}
    const trace:Example={...example,initial:observed.initial,states:observed.states,expected:observed.final,completed:observed.completed},{id:_,...record}=trace;
    try {
      const startDifference=difference(model,initial,observed.initial);if(startDifference){add(example,'failed',`Реализация начала с другого значения «${startDifference}»`,record);continue;}
      const lastDifference=difference(model,observed.states.at(-1)!,observed.final);if(lastDifference){add(example,'unknown',`Итог и последнее наблюдение расходятся: «${lastDifference}»`,record);continue;}
      const expectedDifference=difference(model,example.expected,observed.final);if(expectedDifference){add(example,'failed',`Итог не соответствует примеру: «${expectedDifference}»`,record);continue;}
      if(example.completed && !observed.completed){add(example,'failed','Реализация не завершила предусмотренный пример',record);continue;}
      const result=checkBusinessTrace(model,trace);add(example,result.status,result.detail,record);
    } catch(error){add(example,'unknown',error instanceof Error?error.message:'Не удалось сопоставить наблюдение',record);}
  }
  const count=(status:ConformanceCase['status'])=>cases.filter(item=>item.status===status).length;
  const {examples:_,...generation}=generated || {examples:[]};
  return {kind:'observed_examples',cases,passed:count('passed'),failed:count('failed'),unknown:count('unknown'),totalCases:examples.length,offset,remaining:Math.max(0,examples.length-offset-cases.length),...(generated?{generation:generation as Omit<GeneratedExamples,'examples'>}:{}),note:'Проверены только запущенные примеры и значения, которые предоставил адаптер. Происхождение наблюдений и все остальные поведения реализации не доказаны.'};
}
