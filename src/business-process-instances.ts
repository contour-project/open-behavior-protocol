import type { AlgorithmValue, Expression } from './business-algorithm.ts';
import type { Block, BusinessProcess, ChoiceBranch, Example, Fact, ParallelBranch, ProcessIssue, ProcessReport, Property, PropertyResult, TraceStep } from './business-process.ts';

type Expanded = {model:BusinessProcess;propertyIds:Map<string,string[]>;exampleIds:Map<string,string>;unavailableExamples:Map<string,string>;blockIds:Map<string,{id:string;instance:number}>;factOrigins:Map<string,string>};
const limited=(title:string,instance:number)=>`${title.slice(0,145)} · запуск ${instance+1}`;
const scoped=(id:string)=>/^([1-9]\d{0,4}):(.+)$/.exec(id);
const isObject=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);

// Lower a finite number of independent process runs to ordinary parallel
// branches. Shared facts stay shared; instance facts are renamed per run.
// This is a semantics-preserving expansion, not an assumption about code.
export function expandProcessInstances(source:BusinessProcess):Expanded {
  const count=source.instances || 1, ids=new Map<string,string>(),blockIds=new Map<string,{id:string;instance:number}>(),factIds=new Map<string,string>(),factOrigins=new Map<string,string>();
  if(count>64)throw new Error('Исчерпан предел проверки: за один проход можно развернуть до 64 запусков');
  let blockCounter=0,budget=0;
  const remember=(id:string,instance:number)=>{const key=`${instance}:${id}`;let next=ids.get(key);if(!next){next=`b${instance+1}_${++blockCounter}`;ids.set(key,next);blockIds.set(next,{id,instance:instance+1});}return next;};
  const collect=(blocks:Block[],instance:number)=>blocks.forEach(block=>{remember(block.id,instance);if(block.kind==='group'||block.kind==='repeat')collect(block.steps,instance);if(block.kind==='choice'||block.kind==='parallel')block.branches.forEach(branch=>{remember(branch.id,instance);collect(branch.steps,instance);});});
  for(let instance=0;instance<count;instance++){for(const definition of source.definitions){remember(definition.id,instance);collect(definition.steps,instance);}collect(source.steps,instance);}
  const factId=(id:string,instance:number)=>{const fact=source.facts.find(item=>item.id===id);if(!fact)throw new Error('Неизвестное значение в запуске');const key=fact.scope==='instance'?`${instance}:${id}`:`shared:${id}`,mapped=factIds.get(key);if(!mapped)throw new Error('Не удалось сопоставить значение запуска');return mapped;};
  const facts:Fact[]=[];
  source.facts.forEach((fact,index)=>{const copies=fact.scope==='instance'?count:1;for(let instance=0;instance<copies;instance++){const id=fact.scope==='instance'?`f${index+1}_${instance+1}`:`f${index+1}`,key=fact.scope==='instance'?`${instance}:${fact.id}`:`shared:${fact.id}`,title=fact.scope==='instance'?limited(fact.title,instance):fact.title;const {scope:_,...rest}=fact;facts.push({...rest,id,title});factIds.set(key,id);factOrigins.set(id,fact.scope==='instance' && count>1?`${instance+1}:${fact.id}`:fact.id);}});
  const expression=(value:Expression|null,instance:number):Expression|null=>{
    if(value===null)return null;if(++budget>4096)throw new Error('Слишком много выражений после раскрытия запусков');
    const e=value as Record<string,unknown>,op=e.op;
    if(op==='var')return {...e,id:factId(String(e.id),instance)} as Expression;
    if(op==='field')return {...e} as Expression;
    if(['data_get','data_set','data_insert','data_remove','data_has','data_length'].includes(String(op)))return {...e,source:expression(e.source as Expression,instance),...(Array.isArray(e.path)?{path:e.path.map(item=>expression(item as Expression,instance)!)}:{}),...(op==='data_set' || op==='data_insert'?{value:expression(e.value as Expression,instance)}:{}),...(op==='data_insert'?{index:expression(e.index as Expression,instance)}:{})} as Expression;
    const schemaId=()=>{const [root,...path]=String(e.schema).split('.');return [factId(root!,instance),...path].join('.');};
    if(op==='empty_items' || op==='hole' && e.type==='collection')return {...e,schema:schemaId()} as Expression;
    if(op==='record')return {...e,schema:schemaId(),fields:Object.fromEntries(Object.entries(e.fields as Record<string,Expression>).map(([key,item])=>[key,expression(item,instance)!]))} as Expression;
    if(op==='insert_item')return {...e,collection:expression(e.collection as Expression,instance),item:expression(e.item as Expression,instance)} as Expression;
    if(['any_item','all_items','count_items','filter_items','remove_items','update_items'].includes(String(op)))return {...e,collection:expression(e.collection as Expression,instance),where:expression(e.where as Expression,instance),...(op==='update_items'?{changes:Object.fromEntries(Object.entries(e.changes as Record<string,Expression>).map(([key,item])=>[key,expression(item,instance)!]))}:{})} as Expression;
    if(op==='if')return {...e,condition:expression(e.condition as Expression,instance),then:expression(e.then as Expression,instance),else:expression(e.else as Expression,instance)} as Expression;
    if(['all_instances','any_instances','at_most_one_instance','count_instances'].includes(String(op))) {
      const term=(e.args as Expression[])[0]!,items=Array.from({length:count},(_,i)=>expression(term,i)!);
      const combine=(kind:'and'|'or'|'add',parts:Expression[]):Expression=>{if(!parts.length)return kind==='add'?{op:'integer',value:'0'}:{op:'boolean',value:kind==='and'};while(parts.length>16){const next:Expression[]=[];for(let i=0;i<parts.length;i+=16){const group=parts.slice(i,i+16);next.push(group.length===1?group[0]!:{op:kind,args:group});}parts=next;}return parts.length===1?parts[0]!:{op:kind,args:parts};};
      if(op==='count_instances' || op==='at_most_one_instance'){const total=combine('add',items.map(item=>({op:'if',condition:item,then:{op:'integer',value:'1'},else:{op:'integer',value:'0'}})));return op==='count_instances'?total:{op:'le',args:[total,{op:'integer',value:'1'}]};}
      return combine(op==='all_instances'?'and':'or',items);
    }
    if(Array.isArray(e.args))return {...e,args:(e.args as Expression[]).map(item=>expression(item,instance)!)} as Expression;
    return {...e} as Expression;
  };
  const copyBlocks=(blocks:Block[],instance:number):Block[]=>blocks.map(block=>{
    const id=remember(block.id,instance),title=count>1?limited(block.title,instance):block.title;
    if(block.kind==='action')return {...block,id,title,guard:expression(block.guard,instance),changes:block.changes.map(change=>({factId:factId(change.factId,instance),value:expression(change.value,instance)!}))};
    if(block.kind==='group')return {...block,id,title,steps:copyBlocks(block.steps,instance)};
    if(block.kind==='repeat')return {...block,id,title,when:expression(block.when,instance),steps:copyBlocks(block.steps,instance)};
    if(block.kind==='use')return {...block,id,title,definitionId:remember(block.definitionId,instance)};
    if(block.kind==='call')throw new Error('Сначала загрузите общий блок другого процесса');
    if(block.kind==='choice')return {...block,id,title,branches:block.branches.map(branch=>({...branch,id:remember(branch.id,instance),title:count>1?limited(branch.title,instance):branch.title,when:expression(branch.when,instance),steps:copyBlocks(branch.steps,instance)} as ChoiceBranch))};
    return {...block,id,title,branches:block.branches.map(branch=>({...branch,id:remember(branch.id,instance),title:count>1?limited(branch.title,instance):branch.title,steps:copyBlocks(branch.steps,instance)} as ParallelBranch))};
  });
  const definitions=Array.from({length:count},(_,instance)=>source.definitions.map(definition=>({id:remember(definition.id,instance),title:count>1?limited(definition.title,instance):definition.title,steps:copyBlocks(definition.steps,instance)}))).flat();
  let runs=Array.from({length:count},(_,instance)=>({id:`run${instance+1}`,title:`Запуск ${instance+1}`,steps:copyBlocks(source.steps,instance)}));
  let level=0;while(runs.length>16){const groups=Math.ceil(runs.length/16),size=Math.ceil(runs.length/groups),next:typeof runs=[];for(let start=0;start<runs.length;start+=size){const branch=runs.slice(start,start+size),index=next.length+1;next.push({id:`groupbranch${level}_${index}`,title:'Группа запусков',steps:[{id:`group${level}_${index}`,kind:'parallel',title:'Параллельные запуски',branches:branch}]});}runs=next;level++;}
  const steps:Block[]=count===1?runs[0]!.steps:[{id:'runs',kind:'parallel',title:'Одновременные запуски',branches:runs}];
  const propertyIds=new Map<string,string[]>(),properties:Property[]=[];
  source.properties.forEach((property,index)=>{const converted:string[]=[];for(let instance=0;instance<count;instance++){const id=`p${index+1}_${instance+1}`,entry:Property={...property,id,title:count>1?limited(property.title,instance):property.title,expr:expression(property.expr,instance)};if(property.actionId)entry.actionId=remember(property.actionId,instance);if(property.startActionId)entry.startActionId=remember(property.startActionId,instance);if(property.endActionId)entry.endActionId=remember(property.endActionId,instance);if(property.clockFactId)entry.clockFactId=factId(property.clockFactId,instance);properties.push(entry);converted.push(id);}propertyIds.set(property.id,converted);});
  const exampleIds=new Map<string,string>(),unavailableExamples=new Map<string,string>(),examples:Example[]=[];
  source.examples.forEach((example,index)=>{
    const convertValues=(values:Record<string,AlgorithmValue>)=>{const result:Record<string,AlgorithmValue>={};for(const [key,value] of Object.entries(values)){const match=scoped(key),original=match?match[2]!:key,fact=source.facts.find(item=>item.id===original);if(!fact)throw new Error('Пример ссылается на неизвестное значение');if(count>1 && fact.scope==='instance' && !match)throw new Error(`В примере укажите запуск для «${fact.title}»`);result[factId(original,match?Number(match[1])-1:0)]=value;}return result;};
    try {const actions=example.actions.map(id=>{const match=scoped(id);if(count>1 && !match)throw new Error('В примере укажите запуск для каждого действия');return remember(match?match[2]!:id,match?Number(match[1])-1:0);});const id=`e${index+1}`;examples.push({...example,id,initial:convertValues(example.initial),expected:convertValues(example.expected),...(example.states?{states:example.states.map(convertValues)}:{}),actions});exampleIds.set(example.id,id);}
    catch(error){unavailableExamples.set(example.id,error instanceof Error?error.message:'Пример не определён');}
  });
  const model:BusinessProcess={...source,facts,steps,definitions,properties,examples,bindings:[]};delete model.instances;delete model.entities;
  return {model,propertyIds,exampleIds,unavailableExamples,blockIds,factOrigins};
}

export function translateInstanceReport(source:BusinessProcess,expanded:Expanded,report:ProcessReport):ProcessReport {
  const trace=(items:TraceStep[]|undefined)=>items?.map(item=>{const origin=expanded.blockIds.get(item.id);return origin?{...item,id:`${origin.instance}:${origin.id}`}:{...item};});
  const facts=(values:Record<string,AlgorithmValue>|undefined)=>values && Object.fromEntries(Object.entries(values).map(([id,value])=>[expanded.factOrigins.get(id) || id,value]));
  const properties:PropertyResult[]=source.properties.map(property=>{
    const ids=expanded.propertyIds.get(property.id) || [],results=ids.map(id=>report.properties.find(item=>item.id===id)).filter((item):item is PropertyResult=>!!item);
    const picked=results.find(item=>item.status==='violated') || results.find(item=>item.status==='unknown') || (results.every(item=>item.status==='not_applicable')?results[0]:results.find(item=>item.status==='verified'));
    return picked?{...picked,id:property.id,title:property.title,...(picked.trace?{trace:trace(picked.trace)}:{}),...(picked.facts?{facts:facts(picked.facts)}:{}),...(picked.proof?{proof:{...picked.proof,variables:picked.proof.variables.map(item=>({...item,id:expanded.factOrigins.get(item.id) || item.id}))}}:{})}:{id:property.id,title:property.title,kind:property.kind,status:'unknown',reason:report.reason || 'Проверка не завершена'};
  });
  const issues:ProcessIssue[]=report.issues.map(issue=>({...issue,...(issue.blockId && expanded.blockIds.has(issue.blockId)?{blockId:expanded.blockIds.get(issue.blockId)!.id}:{}),...(issue.trace?{trace:trace(issue.trace)}:{}),...(issue.facts?{facts:facts(issue.facts)}:{})}));
  const examples=source.examples.map(example=>{const problem=expanded.unavailableExamples.get(example.id),id=expanded.exampleIds.get(example.id),result=report.examples.find(item=>item.id===id);return problem?{id:example.id,title:example.title,status:'unknown' as const,detail:problem}:result?{...result,id:example.id,title:example.title}:{id:example.id,title:example.title,status:'unknown' as const,detail:report.reason || 'Проверка не завершена'};});
  const count=source.instances || 1,last=count%10,lastTwo=count%100,word=last===1 && lastTwo!==11?'одновременный запуск':last>=2 && last<=4 && (lastTwo<12 || lastTwo>14)?'одновременных запуска':'одновременных запусков';
  return {...report,scope:{...report.scope,domains:report.scope.domains.map(item=>({...item,id:expanded.factOrigins.get(item.id) || item.id})),semantics:`${count} ${word} одного процесса; локальные значения независимы, общие разделяются. Запуски присутствуют с самого начала. ${report.scope.semantics.replace('Один экземпляр процесса; ','')}`},properties,issues,examples};
}
