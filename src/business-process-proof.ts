import { evaluateExpression, expressionContext, type AlgorithmValue, type Expression } from './business-algorithm.ts';
import type { ActionBlock, Block, BusinessProcess, Fact, ProofEvidence, PropertyResult } from './business-process.ts';

// An interval proof is deliberately independent of the process control flow:
// it proves a predicate for every valid valuation of its referenced facts.
// Unsupported expressions and potential arithmetic errors remain unknown.
type Interval={kind:'integer';min:bigint;max:bigint};
type Truth={kind:'boolean';possible:1|2|3}; // bit 1 = false, bit 2 = true
type Abstract=Interval|Truth;
type Node={op:string;id?:string;value?:unknown;args?:Expression[];condition?:Expression;then?:Expression;else?:Expression};
const MAX_INPUT=10n**30n-1n;
const MAX_RESULT=10n**60n-1n;
const bounded=(min:bigint,max:bigint):Interval|null=>min>=-MAX_RESULT && max<=MAX_RESULT?{kind:'integer',min,max}:null;
const truth=(possible:number):Truth=>({kind:'boolean',possible:possible as 1|2|3});
const choices=(value:Truth):boolean[]=>[...(value.possible&1?[false]:[]),...(value.possible&2?[true]:[])];
const fromValues=(values:boolean[]):Truth=>truth(values.reduce((mask,value)=>mask | (value?2:1),0));
const min=(values:bigint[])=>values.reduce((a,b)=>a<b?a:b);
const max=(values:bigint[])=>values.reduce((a,b)=>a>b?a:b);
type AbstractFacts=Map<string,Interval|Truth>;

function infer(expression:Expression,facts:AbstractFacts,depth=0):Abstract|null {
  if(depth>24 || !expression || typeof expression!=='object')return null;
  const e=expression as Node;
  if(e.op==='integer' && typeof e.value==='string' && /^-?(0|[1-9]\d{0,29})$/.test(e.value)){const value=BigInt(e.value);return bounded(value,value);}
  if(e.op==='boolean' && typeof e.value==='boolean')return truth(e.value?2:1);
  if(e.op==='var' && typeof e.id==='string')return facts.get(e.id) || null;
  if(e.op==='if' && e.condition && e.then && e.else) {
    const condition=infer(e.condition,facts,depth+1);if(condition?.kind!=='boolean')return null;
    if(condition.possible===2)return infer(e.then,facts,depth+1);
    if(condition.possible===1)return infer(e.else,facts,depth+1);
    const left=infer(e.then,facts,depth+1),right=infer(e.else,facts,depth+1);
    if(left?.kind==='integer' && right?.kind==='integer')return bounded(left.min<right.min?left.min:right.min,left.max>right.max?left.max:right.max);
    if(left?.kind==='boolean' && right?.kind==='boolean')return truth(left.possible|right.possible);
    return null;
  }
  if(!Array.isArray(e.args))return null;
  const values=e.args.map(arg=>infer(arg,facts,depth+1));if(values.some(value=>!value))return null;
  const numbers=values.filter((value):value is Interval=>value?.kind==='integer');
  const booleans=values.filter((value):value is Truth=>value?.kind==='boolean');
  if(e.op==='not' && booleans.length===1)return fromValues(choices(booleans[0]!).map(value=>!value));
  if(['and','or'].includes(e.op) && booleans.length===values.length && booleans.length>=2) {
    const canTrue=e.op==='and'?booleans.every(value=>!!(value.possible&2)):booleans.some(value=>!!(value.possible&2));
    const canFalse=e.op==='and'?booleans.some(value=>!!(value.possible&1)):booleans.every(value=>!!(value.possible&1));
    return truth((canFalse?1:0)|(canTrue?2:0));
  }
  if(['eq','ne'].includes(e.op) && booleans.length===2) {
    const results=choices(booleans[0]!).flatMap(left=>choices(booleans[1]!).map(right=>e.op==='eq'?left===right:left!==right));return fromValues(results);
  }
  if(numbers.length!==values.length || !numbers.length)return null;
  if(e.op==='neg' && numbers.length===1)return bounded(-numbers[0]!.max,-numbers[0]!.min);
  if(['add','sub','mul','min','max'].includes(e.op)) {
    if(numbers.length<2 || e.op==='sub' && numbers.length!==2)return null;
    let result=numbers[0]!;
    for(const other of numbers.slice(1)) {
      const candidates=e.op==='mul'?[result.min*other.min,result.min*other.max,result.max*other.min,result.max*other.max]:null;
      const next=e.op==='add'?bounded(result.min+other.min,result.max+other.max):e.op==='sub'?bounded(result.min-other.max,result.max-other.min):e.op==='mul'?bounded(min(candidates!),max(candidates!)):e.op==='min'?bounded(result.min<other.min?result.min:other.min,result.max<other.max?result.max:other.max):bounded(result.min>other.min?result.min:other.min,result.max>other.max?result.max:other.max);
      if(!next)return null;result=next;
    }
    return result;
  }
  if(['eq','ne','lt','le','gt','ge'].includes(e.op) && numbers.length===2) {
    const a=numbers[0]!,b=numbers[1]!,identical=JSON.stringify(e.args[0])===JSON.stringify(e.args[1]);
    if(identical)return truth(['eq','le','ge'].includes(e.op)?2:1);
    const certainlyEqual=a.min===a.max && a.min===b.min && b.min===b.max,certainlyDifferent=a.max<b.min || b.max<a.min;
    if(e.op==='eq' || e.op==='ne'){const yes=e.op==='eq'?certainlyEqual:certainlyDifferent,no=e.op==='eq'?certainlyDifferent:certainlyEqual;return truth(yes?2:no?1:3);}
    const yes=e.op==='lt'?a.max<b.min:e.op==='le'?a.max<=b.min:e.op==='gt'?a.min>b.max:a.min>=b.max;
    const no=e.op==='lt'?a.min>=b.max:e.op==='le'?a.min>b.max:e.op==='gt'?a.max<=b.min:a.max<b.min;
    return truth(yes?2:no?1:3);
  }
  return null;
}

function initialFacts(model:BusinessProcess,allStates:boolean):AbstractFacts {
  const facts:AbstractFacts=new Map();
  for(const fact of model.facts) {
    if(fact.type==='boolean')facts.set(fact.id,!allStates && fact.initial.kind==='value'?truth(fact.initial.value===true?2:1):truth(3));
    else if(fact.type==='integer') {
      const value=!allStates && fact.initial.kind==='value'?BigInt(fact.initial.value as string):null;
      facts.set(fact.id,value===null?{kind:'integer',min:fact.domain?BigInt(fact.domain.min):-MAX_INPUT,max:fact.domain?BigInt(fact.domain.max):MAX_INPUT}:{kind:'integer',min:value,max:value});
    }
  }
  return facts;
}

// Intersect only constraints we understand; ignoring the rest over-approximates
// the possible states and therefore cannot turn a failed proof into a proof.
function assumeTrue(expression:Expression,facts:AbstractFacts,depth=0):boolean {
  if(depth>24)return true;const e=expression as Node;
  if(e.op==='boolean')return e.value===true;
  if(e.op==='and' && Array.isArray(e.args))return e.args.every(arg=>assumeTrue(arg,facts,depth+1));
  let booleanId:string|undefined,positive=true;
  if(e.op==='var')booleanId=e.id;
  if(e.op==='not' && e.args?.length===1){const inner=e.args[0] as Node;if(inner.op==='var'){booleanId=inner.id;positive=false;}}
  if(booleanId){const value=facts.get(booleanId);if(value?.kind==='boolean'){const bit=positive?2:1;if(!(value.possible&bit))return false;facts.set(booleanId,truth(bit));}return true;}
  if(!['eq','lt','le','gt','ge'].includes(e.op) || e.args?.length!==2)return true;
  const left=e.args[0] as Node,right=e.args[1] as Node;let variable=left,constant=right,operator=e.op;
  if(left.op==='integer' && right.op==='var'){variable=right;constant=left;operator=({lt:'gt',le:'ge',gt:'lt',ge:'le',eq:'eq'} as Record<string,string>)[operator]!;}
  if(variable.op!=='var' || !variable.id || constant.op!=='integer' || typeof constant.value!=='string' || !/^-?(0|[1-9]\d{0,29})$/.test(constant.value))return true;
  const interval=facts.get(variable.id);if(interval?.kind!=='integer')return true;const value=BigInt(constant.value);
  let lower=interval.min,upper=interval.max;
  if(operator==='eq'){lower=value>lower?value:lower;upper=value<upper?value:upper;}
  if(operator==='gt' || operator==='ge'){const bound=value+(operator==='gt'?1n:0n);if(bound>lower)lower=bound;}
  if(operator==='lt' || operator==='le'){const bound=value-(operator==='lt'?1n:0n);if(bound<upper)upper=bound;}
  if(lower>upper)return false;facts.set(variable.id,{kind:'integer',min:lower,max:upper});return true;
}

function referencedFacts(expression:Expression):Set<string> {
  const ids=new Set<string>();
  const visit=(value:unknown):void=>{if(!value || typeof value!=='object')return;if(Array.isArray(value)){value.forEach(visit);return;}const node=value as Record<string,unknown>;if(node.op==='var' && typeof node.id==='string')ids.add(node.id);Object.values(node).forEach(visit);};
  visit(expression);return ids;
}
function actions(model:BusinessProcess):ActionBlock[] {
  const result:ActionBlock[]=[];
  const visit=(items:Block[]):void=>{for(const item of items){if(item.kind==='action')result.push(item);else if(item.kind==='group' || item.kind==='repeat')visit(item.steps);else if(item.kind==='choice' || item.kind==='parallel')for(const branch of item.branches)visit(branch.steps);}};
  visit(model.steps);for(const definition of model.definitions)visit(definition.steps);return result;
}
function proveInductively(expression:Expression,model:BusinessProcess,allFacts:AbstractFacts,steps:ActionBlock[]):ProofEvidence['actions']|null {
  const start=infer(expression,initialFacts(model,false));if(start?.kind!=='boolean' || start.possible!==2)return null;
  const evidence:ProofEvidence['actions']=[];
  const used=referencedFacts(expression);
  for(const action of steps) {
    const changes=action.changes.filter(change=>used.has(change.factId));if(!changes.length){evidence.push({title:action.title,outcome:'unchanged'});continue;}
    const before=new Map(allFacts);if(!assumeTrue(expression,before)){evidence.push({title:action.title,outcome:'guard_impossible'});continue;}
    if(action.guard && !assumeTrue(action.guard,before)){evidence.push({title:action.title,outcome:'guard_impossible'});continue;}
    const guard=action.guard?infer(action.guard,before):null;if(guard?.kind==='boolean' && guard.possible===1){evidence.push({title:action.title,outcome:'guard_impossible'});continue;}
    const after=new Map(before),updates:[string,Abstract][]=[];
    for(const change of changes){const result=infer(change.value,before);if(!result)return null;updates.push([change.factId,result]);}
    for(const [id,value] of updates)after.set(id,value);
    const preserved=infer(expression,after);if(preserved?.kind!=='boolean' || preserved.possible!==2)return null;
    evidence.push({title:action.title,outcome:'preserved'});
  }
  return evidence;
}

export function proveUniversalInvariants(model:BusinessProcess):PropertyResult[] {
  const facts=initialFacts(model,true),steps=actions(model);
  return model.properties.map(property=>{
    const used=property.expr?referencedFacts(property.expr):new Set<string>();
    const result=property.kind==='always' && property.expr?infer(property.expr,facts):null;
    const hasInteger=model.facts.some(fact=>used.has(fact.id) && fact.type==='integer');
    const universal=result?.kind==='boolean' && result.possible===2,inductive=!universal && hasInteger && property.kind==='always' && property.expr?proveInductively(property.expr,model,facts,steps):null;
    const reason=universal?'Доказано для всех допустимых значений данных по их типам и диапазонам; переходы процесса не исследованы.':inductive?'Доказано начальное значение и сохранение свойства всеми описанными действиями. Достижимость, завершение и ошибки действий не проверены.':undefined;
    const variables:ProofEvidence['variables']=[];for(const fact of model.facts){const value=facts.get(fact.id);if(!used.has(fact.id) || !value)continue;if(value.kind==='integer')variables.push({id:fact.id,title:fact.title,type:'integer',min:String(value.min),max:String(value.max)});else variables.push({id:fact.id,title:fact.title,type:'boolean'});}
    return {id:property.id,title:property.title,kind:property.kind,status:reason?'verified':'unknown',...(reason?{reason,proofMethod:universal?'interval' as const:'induction' as const,proof:{variables,actions:inductive || []}}:{})};
  });
}

// A concrete initial state is a counterexample, never evidence of completeness.
// Vary one value at a time and keep a strict bound on work for large projects.
function sampleValues(fact:Fact):AlgorithmValue[] {
  if(fact.initial.kind==='value')return [fact.initial.value];
  if(fact.initial.kind!=='any')return [];
  if(fact.type==='boolean')return [false,true];
  if(fact.type==='choice')return fact.options?.length?[fact.options[0]!,fact.options[fact.options.length-1]!]:[];
  if(fact.type==='collection')return [[]];
  if(fact.type==='data')return [];
  if(fact.type==='text')return ['','A'];
  if(fact.type==='decimal')return ['0','1','-1'];
  if(fact.type==='date')return fact.domain?[fact.domain.min,fact.domain.max]:['1970-01-01'];
  if(fact.type==='instant')return fact.domain?[fact.domain.min,fact.domain.max]:['1970-01-01T00:00:00Z'];
  const lower=fact.domain?BigInt(fact.domain.min):-MAX_INPUT,upper=fact.domain?BigInt(fact.domain.max):MAX_INPUT;
  return [...new Set([lower,upper,0n,1n,-1n].filter(value=>value>=lower && value<=upper).map(String))];
}

export function findInitialCounterexamples(model:BusinessProcess):Map<string,PropertyResult> {
  const results=new Map<string,PropertyResult>(),options=model.facts.map(sampleValues);
  if(options.some(values=>!values.length))return results;
  const initial:Record<string,AlgorithmValue>={};model.facts.forEach((fact,index)=>{initial[fact.id]=options[index]![0]!;});
  const states=[initial];for(let index=0;index<model.facts.length && states.length<64;index++)for(const value of options[index]!.slice(1)){if(states.length>=64)break;states.push({...initial,[model.facts[index]!.id]:value});}
  const properties=model.properties.filter(property=>{if(property.kind!=='always' || !property.expr)return false;const used=referencedFacts(property.expr);return model.facts.some(fact=>fact.type==='integer' && used.has(fact.id));});
  for(const state of states){let context:Map<string,unknown>;try{context=expressionContext(model.facts,state);}catch{continue;}
    for(const property of properties){if(results.has(property.id))continue;try{if(evaluateExpression(property.expr!,context)===false)results.set(property.id,{id:property.id,title:property.title,kind:property.kind,status:'violated',facts:state,trace:[],reason:'Нарушение найдено в допустимом начальном состоянии; остальные состояния не исследованы полностью.'});}catch{ /* This sample says nothing about the property. */ }}
  }
  return results;
}
