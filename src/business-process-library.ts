import type { Block, BusinessProcess } from './business-process.ts';
import type { AlgorithmInput } from './business-algorithm.ts';
import { dataDefinitionsKey } from './business-data.ts';

// A reusable block depends only on facts referenced by its body, including
// nested local blocks and arguments supplied to other processes.
export function requiredDefinitionFacts(model:BusinessProcess,definitionId:string):string[] {
  const found=new Set<string>(),visited=new Set<string>(),active=new Set<string>();
  const scan=(value:unknown):void=>{if(!value || typeof value!=='object')return;if(Array.isArray(value)){value.forEach(scan);return;}const object=value as Record<string,unknown>;if(object.op==='var' && typeof object.id==='string')found.add(object.id);if((object.op==='record' || object.op==='empty_items' || object.op==='hole' && object.type==='collection') && typeof object.schema==='string')found.add(object.schema.split('.')[0]!);for(const value of Object.values(object))scan(value);};
  const definition=(id:string)=>{if(active.has(id))throw new Error('Общие блоки не могут вызывать друг друга по кругу');if(visited.has(id))return;const item=model.definitions.find(value=>value.id===id);if(!item)throw new Error('Общий блок не найден');active.add(id);blocks(item.steps);active.delete(id);visited.add(id);};
  const blocks=(items:Block[])=>{for(const block of items){if(block.kind==='action'){scan(block.guard);for(const change of block.changes){found.add(change.factId);scan(change.value);}}else if(block.kind==='repeat'){scan(block.when);blocks(block.steps);}else if(block.kind==='group')blocks(block.steps);else if(block.kind==='use')definition(block.definitionId);else if(block.kind==='call')Object.values(block.arguments).forEach(id=>found.add(id));else {if(block.kind==='choice')block.branches.forEach(branch=>scan(branch.when));block.branches.forEach(branch=>blocks(branch.steps));}}};
  definition(definitionId);return model.facts.filter(fact=>found.has(fact.id)).map(fact=>fact.id);
}

export function processCalls(model:BusinessProcess):Extract<Block,{kind:'call'}>[] {
  const result:Extract<Block,{kind:'call'}>[]=[];
  const visit=(items:Block[])=>{for(const item of items){if(item.kind==='call')result.push(item);else if(item.kind==='group'||item.kind==='repeat')visit(item.steps);else if(item.kind==='choice'||item.kind==='parallel')item.branches.forEach(branch=>visit(branch.steps));}};
  visit(model.steps);model.definitions.forEach(definition=>visit(definition.steps));return result;
}

export function compatibleParameter(source:BusinessProcess['facts'][number],target:BusinessProcess['facts'][number]):boolean {
  const fields=(fact:AlgorithmInput):unknown=>fact.type==='collection'?fact.fields.map(field=>field.type==='collection'?{id:field.id,type:field.type,fields:fields(field)}:{id:field.id,type:field.type,unit:field.unit || '',domain:field.domain || null,options:field.options?[...field.options].sort():null}).sort((a,b)=>a.id.localeCompare(b.id)):null;
  return source.type===target.type && (source.unit || '')===(target.unit || '') && (source.scope || 'shared')===(target.scope || 'shared') && (source.type!=='choice' || JSON.stringify([...(source.options || [])].sort())===JSON.stringify([...(target.options || [])].sort())) && (source.type!=='collection' || JSON.stringify(fields(source))===JSON.stringify(fields(target))) && (source.type!=='data' || target.type==='data' && dataDefinitionsKey(source.dataSchema)===dataDefinitionsKey(target.dataSchema));
}
