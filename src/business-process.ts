import { calendarDate, calendarDay, instantSecond, instantValue, evaluateExpression, expressionContext, typeOfExpression, validateAlgorithm, validateCollectionInput, validateExpressionValues, type AlgorithmInput, type AlgorithmCollectionInput, type AlgorithmScalarInput, type AlgorithmValue, type Expression } from './business-algorithm.ts';
import { expandProcessInstances, translateInstanceReport } from './business-process-instances.ts';
import { findInitialCounterexamples, proveUniversalInvariants } from './business-process-proof.ts';
import { addFractionalProofs } from './business-process-smt-runner.ts';
import { dataDefinitionsKey, validateDataDefinitions } from './business-data.ts';
import { BUSINESS_PROCESS_JSON_LIMIT } from './business-process-limits.ts';

export type InitialValue = {kind:'unknown'} | {kind:'any'} | {kind:'value';value:AlgorithmValue};
export type Fact = AlgorithmInput & {initial:InitialValue;scope?:'shared'|'instance'};
export type ActionBlock = {id:string;kind:'action';title:string;actor:string;guard:Expression|null;changes:{factId:string;value:Expression}[];specified:boolean};
export type GroupBlock = {id:string;kind:'group';title:string;steps:Block[]};
export type ChoiceBranch = {id:string;title:string;when:Expression|null;otherwise:boolean;steps:Block[]};
export type ParallelBranch = {id:string;title:string;steps:Block[]};
export type ChoiceBlock = {id:string;kind:'choice';title:string;exclusive:boolean;branches:ChoiceBranch[]};
export type ParallelBlock = {id:string;kind:'parallel';title:string;branches:ParallelBranch[]};
export type RepeatBlock = {id:string;kind:'repeat';title:string;when:Expression|null;steps:Block[]};
export type UseBlock = {id:string;kind:'use';title:string;definitionId:string};
export type CallBlock = {id:string;kind:'call';title:string;processId:string;revision:number;definitionId:string;arguments:Record<string,string>};
export type Block = ActionBlock | GroupBlock | ChoiceBlock | ParallelBlock | RepeatBlock | UseBlock | CallBlock;
export type Definition = {id:string;title:string;steps:Block[]};
export type Property = {id:string;title:string;kind:'always'|'after'|'eventually'|'within';expr:Expression|null;actionId?:string;startActionId?:string;endActionId?:string;clockFactId?:string;withinSeconds?:string};
export type Example = {id:string;title:string;initial:Record<string,AlgorithmValue>;actions:string[];states?:Record<string,AlgorithmValue>[];expected:Record<string,AlgorithmValue>;completed:boolean};
export type Binding = {blockId:string;implementationId:string};
export type BusinessEntity = {id:string;title:string;nodeId:string|null;fields:string[]};
export type SourceReference = {moduleId:string|null;path:string;sha256:string};
export type BusinessProcess = {version:1;intent:string;basis:{kind:'unknown'|'requirement'|'code'|'mixed';note:string;sources:SourceReference[]};assumptions:{progress:'may_wait'|'advance'};instances?:number;facts:Fact[];entities?:BusinessEntity[];steps:Block[];definitions:Definition[];properties:Property[];examples:Example[];bindings:Binding[]};
export type ProcessIssue = {kind:string;title:string;blockId?:string;facts?:Record<string,AlgorithmValue>;trace?:TraceStep[];detail?:string};
export type TraceStep = {kind:'action'|'branch';id:string;title:string};
export type ProofEvidence = {variables:{id:string;title:string;type:'integer'|'decimal'|'boolean';min?:string;max?:string}[];actions:{title:string;outcome:'unchanged'|'guard_impossible'|'preserved'}[]};
export type PropertyResult = {id:string;title:string;kind:Property['kind'];status:'verified'|'violated'|'unknown'|'not_applicable';proofMethod?:'interval'|'induction'|'smt'|'smt_conditional';proof?:ProofEvidence;facts?:Record<string,AlgorithmValue>;trace?:TraceStep[];reason?:string};
export type ProcessReport = {complete:boolean;scope:{initial:number;states:number;transitions:number;semantics:string;domains:{id:string;title:string;type:string;initial:InitialValue;domain?:{min:string;max:string};options?:string[]}[]};properties:PropertyResult[];issues:ProcessIssue[];examples:{id:string;title:string;status:'passed'|'failed'|'unknown';detail:string}[];reason?:string};

const MAX_STATES=5000,MAX_INITIAL=2048,MAX_EXAMPLE_STATES=500;
const ident=/^[a-z][a-z0-9_-]{0,63}$/;
const plain=(x:unknown):x is Record<string,unknown>=>!!x && typeof x==='object' && !Array.isArray(x);
function fail(message:string):never {throw Object.assign(new Error(message),{status:400});}
const validTitle=(x:unknown):x is string=>typeof x==='string' && !!x.trim() && x.length<=180;
const validId=(x:unknown):x is string=>typeof x==='string' && ident.test(x);
const unique=<T>(items:T[],key:(item:T)=>string)=>new Set(items.map(key)).size===items.length;
const allowed=(value:object,keys:string[],path='модель')=>{const extra=Object.keys(value).filter(key=>!keys.includes(key));if(extra.length)fail(`Неизвестное поле модели процесса: ${path}.${extra[0]}. Допустимые поля: ${keys.join(', ')}.`);};
const bool=(value:unknown):value is boolean=>typeof value==='boolean';
function expressionShape(value:unknown,depth=0):void {
  if(depth>24 || !plain(value) || typeof value.op!=='string')fail('Некорректное выражение');
  if(value.op==='hole'){allowed(value,['op','type','schema']);return;}
  if(value.op==='var'){allowed(value,['op','id']);return;}
  if(value.op==='field'){allowed(value,['op','record','field']);return;}
  if(value.op==='data_literal'){allowed(value,['op','json']);return;}
  if(['data_get','data_set','data_insert','data_remove','data_has','data_length'].includes(value.op)){
    allowed(value,value.op==='data_get'?['op','source','path','result']:value.op==='data_set'?['op','source','path','value']:value.op==='data_insert'?['op','source','path','index','value']:value.op==='data_length'?['op','source']:['op','source','path']);expressionShape(value.source,depth+1);
    if(value.op!=='data_length'){if(!Array.isArray(value.path))fail('Укажите путь к данным');for(const part of value.path)expressionShape(part,depth+1);}
    if(value.op==='data_set' || value.op==='data_insert')expressionShape(value.value,depth+1);if(value.op==='data_insert')expressionShape(value.index,depth+1);return;
  }
  if(value.op==='empty_items'){allowed(value,['op','schema']);return;}
  if(value.op==='record'){allowed(value,['op','schema','fields']);if(!plain(value.fields))fail('Укажите поля записи');for(const entry of Object.values(value.fields))expressionShape(entry,depth+1);return;}
  if(value.op==='insert_item'){allowed(value,['op','collection','item']);expressionShape(value.collection,depth+1);expressionShape(value.item,depth+1);return;}
  if(['any_item','all_items','count_items','filter_items','remove_items','update_items'].includes(value.op)){
    allowed(value,value.op==='update_items'?['op','collection','as','where','changes']:['op','collection','as','where']);expressionShape(value.collection,depth+1);expressionShape(value.where,depth+1);
    if(value.op==='update_items'){if(!plain(value.changes))fail('Укажите изменяемые поля');for(const entry of Object.values(value.changes))expressionShape(entry,depth+1);}return;
  }
  if(['integer','decimal','boolean','text','date','instant'].includes(value.op)){allowed(value,['op','value']);return;}
  if(value.op==='if'){allowed(value,['op','condition','then','else']);expressionShape(value.condition,depth+1);expressionShape(value.then,depth+1);expressionShape(value.else,depth+1);return;}
  allowed(value,['op','args',...(['div','round'].includes(value.op)?['rounding']:[])]);
  if(!Array.isArray(value.args))fail('У операции отсутствуют аргументы');for(const item of value.args)expressionShape(item,depth+1);
}
const expressionType=(value:Expression,scope:Map<string,string>,budget:{count:number})=>{expressionShape(value);return typeOfExpression(value,scope,budget);};
const boolExpr=(value:Expression|null,scope:Map<string,string>,budget:{count:number})=>{if(value!==null && expressionType(value,scope,budget)!=='boolean')fail('Условие должно быть логическим');};
const scalar=(value:unknown):value is AlgorithmValue=>typeof value==='boolean' || typeof value==='string';

export function emptyBusinessProcess():BusinessProcess {return {version:1,intent:'',basis:{kind:'unknown',note:'',sources:[]},assumptions:{progress:'may_wait'},facts:[],steps:[],definitions:[],properties:[],examples:[],bindings:[]};}

// Validity and completeness are different: unresolved blocks may be saved but
// cannot produce a proof. Every saved node has a stable id for bindings.
export function validateBusinessProcess(value:unknown):BusinessProcess {
  if(!plain(value) || value.version!==1 || JSON.stringify(value).length>BUSINESS_PROCESS_JSON_LIMIT)fail('Некорректная версия или размер модели процесса');
  allowed(value,['version','intent','basis','assumptions','instances','facts','entities','steps','definitions','properties','examples','bindings'],'model');
  if(typeof value.intent!=='string' || value.intent.length>2000 || !plain(value.basis) || !['unknown','requirement','code','mixed'].includes(String(value.basis.kind)) || typeof value.basis.note!=='string' || value.basis.note.length>500 || !Array.isArray(value.basis.sources) || value.basis.sources.length>64)fail('Некорректное назначение модели');
  allowed(value.basis,['kind','note','sources'],'basis');
  for(const [index,source] of value.basis.sources.entries()) {if(!plain(source))fail('Некорректный источник');allowed(source,['moduleId','path','sha256'],`basis.sources[${index}]`);if(source.moduleId!==null && (typeof source.moduleId!=='string' || !/^[a-f0-9-]{36}$/i.test(source.moduleId)) || typeof source.path!=='string' || !source.path || source.path.length>500 || source.path.startsWith('/') || /^[a-z]:/i.test(source.path) || source.path.split(/[\\/]/).some(part=>!part || part==='.' || part==='..') || /[\x00-\x1f]/.test(source.path) || typeof source.sha256!=='string' || !/^[a-f0-9]{64}$/i.test(source.sha256))fail('Некорректный источник');}
  if(['code','mixed'].includes(String(value.basis.kind)) && !value.basis.sources.length || ['requirement','unknown'].includes(String(value.basis.kind)) && value.basis.sources.length)fail('Источники кода несовместимы с происхождением модели');
  if(!plain(value.assumptions) || !['may_wait','advance'].includes(String(value.assumptions.progress)))fail('Укажите допущение о ходе процесса');allowed(value.assumptions,['progress'],'assumptions');
  if(value.instances!==undefined && (!Number.isSafeInteger(value.instances) || (value.instances as number)<1 || (value.instances as number)>10000))fail('Укажите от 1 до 10000 одновременных запусков');
  for(const [name,max] of [['facts',64],['steps',100],['definitions',32],['properties',64],['examples',32],['bindings',200]] as const)if(!Array.isArray(value[name]) || (value[name] as unknown[]).length>max)fail(`Некорректный список: ${name}`);
  const spec=value as unknown as BusinessProcess,ids=new Map<string,string>(),scope=new Map<string,string>(),budget={count:0,limit:4096,allowHoles:true,allowQuantifiers:true,allowTextOps:true,allowDataOps:true,collections:new Map<string,AlgorithmCollectionInput>()};
  const claim=(id:unknown,title:unknown,path:string)=>{
    if(!validId(id))fail(`${path}.id: используйте 1–64 символа, начиная со строчной латинской буквы; далее допустимы a–z, цифры, _ и -.`);
    if(!validTitle(title))fail(`${path}.title: укажите непустое название длиной до 180 символов.`);
    const previous=ids.get(id);if(previous)fail(`${path}.id: идентификатор «${id}» уже занят в ${previous}; id всех фактов, сущностей, блоков, ветвей, свойств и примеров должны различаться.`);
    ids.set(id,path);
  };
  for(const [index,fact] of spec.facts.entries()) {
    if(!plain(fact) || !plain(fact.initial))fail(`facts[${index}].initial: укажите начальное значение в формате {kind: "unknown"}, {kind: "any"} или {kind: "value", value: ...}.`);
    allowed(fact,['id','title','type','unit','domain','options','fields','dataSchema','initial','scope'],`facts[${index}]`);
    if(fact.scope!==undefined && !['shared','instance'].includes(fact.scope))fail('Укажите область значения');
    allowed(fact.initial,['kind','value'],`facts[${index}].initial`);
    claim(fact.id,fact.title,`facts[${index}]`);
    if(!['unknown','any','value'].includes(fact.initial.kind))fail(`facts[${index}].initial.kind: допустимы unknown, any или value.`);
    if(fact.initial.kind==='value' && !(fact.type==='collection'?Array.isArray(fact.initial.value):scalar(fact.initial.value)) || fact.initial.kind!=='value' && Object.hasOwn(fact.initial,'value'))fail(`facts[${index}].initial.value: значение должно соответствовать типу факта; при unknown или any поле value отсутствует.`);
    if(fact.type==='collection'){if('dataSchema' in fact)fail('Схема данных относится к другому типу');validateCollectionInput(fact);const register=(item:AlgorithmCollectionInput,path:string):void=>{budget.collections.set(path,{...item,id:path});for(const field of item.fields)if(field.type==='collection')register(field,`${path}.${field.id}`);};register(fact,fact.id);scope.set(fact.id,`collection:${fact.id}`);}else if(fact.type==='data'){if('fields' in fact || 'unit' in fact || 'domain' in fact || 'options' in fact)fail('Некорректная схема данных');try{validateDataDefinitions(fact.dataSchema);}catch(error){fail(error instanceof Error?error.message:'Некорректная схема данных');}scope.set(fact.id,`data:${fact.id}`);}else {if('fields' in fact || 'dataSchema' in fact)fail('Поля и схема доступны только у соответствующих типов');scope.set(fact.id,fact.type==='choice'?'text':fact.type==='decimal'?'number':fact.type);}
  }
  // Reuse the calculation language's type and domain rules.
  const inputs:AlgorithmScalarInput[]=spec.facts.filter((input):input is Fact & AlgorithmScalarInput=>input.type!=='collection' && input.type!=='data').map(({initial,scope:_,...input})=>input.type==='choice' && !input.options?.length && initial.kind==='unknown'?{...input,options:['contour-unset']}:input);
  let validationId='contour_validation_result';while(scope.has(validationId))validationId=`v${validationId.slice(0,30)}`;
  for(const input of inputs)try{validateAlgorithm({version:1,inputs:[input],steps:[],outputs:[{id:validationId,title:'Результат',expr:{op:'boolean',value:true}}],requires:[],ensures:[],examples:[]});}catch(error){const index=spec.facts.findIndex(fact=>fact.id===input.id);fail(`facts[${index}] (${input.id}): ${error instanceof Error?error.message:'Некорректные параметры факта'}`);}
  for(const [index,fact] of spec.facts.entries())if(fact.initial.kind==='value')try{validateExpressionValues([fact],{[fact.id]:fact.initial.value});}catch(error){fail(`facts[${index}].initial.value: ${error instanceof Error?error.message:'Значение не соответствует типу факта'}`);}
  if(spec.entities!==undefined && (!Array.isArray(spec.entities) || spec.entities.length>64))fail('Некорректный список сущностей процесса');
  const groupedFields=new Set<string>();for(const [index,entity] of (spec.entities || []).entries()) {
    if(!plain(entity) || !Array.isArray(entity.fields) || entity.fields.length>64)fail('Некорректная сущность процесса');allowed(entity,['id','title','nodeId','fields'],`entities[${index}]`);claim(entity.id,entity.title,`entities[${index}]`);
    if(entity.nodeId!==null && (typeof entity.nodeId!=='string' || !/^[a-f0-9-]{36}$/i.test(entity.nodeId)))fail('Некорректная сущность карты');
    for(const id of entity.fields){if(typeof id!=='string' || !scope.has(id) || groupedFields.has(id))fail('Поле сущности не найдено или уже входит в другую сущность');groupedFields.add(id);}
  }
  const definitions=new Map<string,Definition>(),actions=new Set<string>(),externalCalls=new Set<string>(),bindable=new Set<string>(),calls=new Map<string,Set<string>>();
  for(const [index,definition] of spec.definitions.entries()) {
    if(!plain(definition) || !Array.isArray(definition.steps))fail('Некорректный общий блок');
    allowed(definition,['id','title','steps'],`definitions[${index}]`);claim(definition.id,definition.title,`definitions[${index}]`);definitions.set(definition.id,definition);bindable.add(definition.id);
  }
  let blocks=0;
  const walk=(steps:Block[],owner:string,depth=0,path='steps'):void=>{
    if(depth>12 || !Array.isArray(steps) || steps.length>100)fail('Слишком сложная структура процесса');
    for(const [index,block] of steps.entries()) {
      if(++blocks>250 || !plain(block))fail('Слишком много блоков');
      const blockPath=`${path}[${index}]`;claim(block.id,block.title,blockPath);bindable.add(block.id);
      if(block.kind==='action') {
        allowed(block,['id','kind','title','actor','guard','changes','specified'],blockPath);
        if(typeof block.actor!=='string' || block.actor.length>180)fail(`${blockPath}.actor: укажите исполнителя строкой до 180 символов; пустая строка допустима.`);
        if(!bool(block.specified))fail(`${blockPath}.specified: укажите true, если действие определено, или false, если оно пока неизвестно.`);
        if(!Array.isArray(block.changes) || block.changes.length>64)fail(`${blockPath}.changes: укажите массив изменений значений (до 64); если действие ничего не меняет, передайте [].`);
        if(block.guard===undefined)fail(`${blockPath}.guard: укажите логическое выражение, {"op":"boolean","value":true} без условия или null, если условие неизвестно.`);
        if(block.changes.some(item=>!plain(item)))fail(`${blockPath}.changes: каждый элемент должен содержать factId и value.`);
        if(!unique(block.changes,item=>item.factId))fail(`${blockPath}.changes: одно значение нельзя изменить несколько раз в одном действии.`);
        try{boolExpr(block.guard,scope,budget);}catch(error){fail(`${blockPath}.guard: ${error instanceof Error?error.message:'Некорректное условие'}`);}actions.add(block.id);
        for(const [changeIndex,change] of block.changes.entries()) {
          const changePath=`${blockPath}.changes[${changeIndex}]`;
          if(!plain(change) || !scope.has(change.factId))fail(`${changePath}.factId: укажите id существующего значения из facts.`);allowed(change,['factId','value'],changePath);
          let actual:string;try{actual=expressionType(change.value,scope,budget);}catch(error){fail(`${changePath}.value: ${error instanceof Error?error.message:'Некорректное выражение'}`);}const expected=scope.get(change.factId);
          if(actual!==expected && !(expected==='number' && actual==='integer') && !(expected?.startsWith('data:') && actual.startsWith('data:')))fail(`${changePath}.value: результат не соответствует типу значения «${change.factId}» (${expected}).`);
        }
      } else if(block.kind==='group' || block.kind==='repeat') {
        allowed(block,block.kind==='group'?['id','kind','title','steps']:['id','kind','title','when','steps'],blockPath);
        if(block.kind==='repeat')boolExpr(block.when,scope,budget);walk(block.steps,owner,depth+1,`${blockPath}.steps`);
      } else if(block.kind==='choice' || block.kind==='parallel') {
        allowed(block,block.kind==='choice'?['id','kind','title','exclusive','branches']:['id','kind','title','branches'],blockPath);
        if(!Array.isArray(block.branches) || block.branches.length>16 || block.kind==='choice' && !bool(block.exclusive))fail('Некорректные ветви');
        let otherwise=0;
        for(const [branchIndex,branch] of block.branches.entries()) {
          if(!plain(branch) || !Array.isArray(branch.steps))fail('Некорректная ветвь');
          const branchPath=`${blockPath}.branches[${branchIndex}]`;allowed(branch,block.kind==='choice'?['id','title','when','otherwise','steps']:['id','title','steps'],branchPath);claim(branch.id,branch.title,branchPath);bindable.add(branch.id);
          if(block.kind==='choice') {const item=branch as ChoiceBranch;if(!bool(item.otherwise))fail('Некорректная ветвь');if(item.otherwise){otherwise++;if(item.when!==null)fail('Ветка «иначе» не имеет отдельного условия');}else boolExpr(item.when,scope,budget);}
          walk(branch.steps,owner,depth+1,`${branchPath}.steps`);
        }
        if(otherwise>1)fail('Допустима только одна ветка «иначе»');
      } else if(block.kind==='use') {
        allowed(block,['id','kind','title','definitionId'],blockPath);if(!validId(block.definitionId) || !definitions.has(block.definitionId))fail('Общий блок не найден');
        if(owner){if(!calls.has(owner))calls.set(owner,new Set());calls.get(owner)?.add(block.definitionId);}
      } else if(block.kind==='call') {
        allowed(block,['id','kind','title','processId','revision','definitionId','arguments'],blockPath);
        if(typeof block.processId!=='string' || !/^[a-f0-9-]{36}$/i.test(block.processId) || !Number.isSafeInteger(block.revision) || block.revision<1 || !validId(block.definitionId) || !plain(block.arguments) || Object.keys(block.arguments).length>64 || Object.entries(block.arguments).some(([id,target])=>!validId(id) || typeof target!=='string' || !scope.has(target)))fail('Некорректная ссылка на общий блок другого процесса');
        externalCalls.add(block.id);
      } else fail('Неизвестный вид блока');
    }
  };
  walk(spec.steps,'');for(const [index,definition] of spec.definitions.entries())walk(definition.steps,definition.id,0,`definitions[${index}].steps`);
  const visited=new Set<string>(),active=new Set<string>();
  const visit=(id:string,depth=0)=>{if(depth>12 || active.has(id))fail('Общие блоки не могут вызывать друг друга по кругу');if(visited.has(id))return;active.add(id);for(const next of calls.get(id) || [])visit(next,depth+1);active.delete(id);visited.add(id);};
  for(const id of definitions.keys())visit(id);
  // A path into an external block is checked against the referenced version
  // when that block is resolved. The root and every segment are constrained
  // here so an unresolved dependency can never turn into a local action.
  const actionReference=(id:unknown):boolean=>{if(typeof id!=='string')return false;if(actions.has(id))return true;const parts=id.split('/');return parts.length>=2 && parts.length<=14 && externalCalls.has(parts[0]!) && parts.every(validId);};
  for(const [index,property] of spec.properties.entries()) {
    if(!plain(property))fail('Некорректное свойство');allowed(property,['id','title','kind','expr','actionId','startActionId','endActionId','clockFactId','withinSeconds'],`properties[${index}]`);claim(property.id,property.title,`properties[${index}]`);
    if(!['always','after','eventually','within'].includes(property.kind))fail('Неизвестный вид свойства');boolExpr(property.expr,scope,budget);
    if(property.kind==='after' && property.actionId && !actionReference(property.actionId) || property.kind!=='after' && property.actionId)fail('Укажите действие для свойства');
    if(property.kind==='within') {
      if(property.expr!==null || property.startActionId && !actionReference(property.startActionId) || property.endActionId && !actionReference(property.endActionId) || property.startActionId && property.startActionId===property.endActionId || property.clockFactId && scope.get(property.clockFactId)!=='instant' || property.withinSeconds!==undefined && !/^(0|[1-9]\d{0,8})$/.test(property.withinSeconds))fail('Некорректное ограничение времени');
    } else if(property.startActionId || property.endActionId || property.clockFactId || property.withinSeconds!==undefined)fail('Временные параметры относятся только к сроку');
  }
  const factMap=new Map(spec.facts.map(item=>[item.id,item]));
  for(const [index,example] of spec.examples.entries()) {
    if(!plain(example) || !plain(example.initial) || !plain(example.expected) || !Array.isArray(example.actions) || example.actions.length>100 || !bool(example.completed))fail('Некорректный пример');
    allowed(example,['id','title','initial','actions','states','expected','completed'],`examples[${index}]`);claim(example.id,example.title,`examples[${index}]`);
    if(example.states!==undefined && (!Array.isArray(example.states) || example.states.length!==example.actions.length || example.states.some(item=>!plain(item))))fail('Укажите состояние для каждого шага примера');
    if(example.actions.some(id=>{const match=/^([1-9]\d{0,4}):(.+)$/.exec(id);return match?Number(match[1])>(spec.instances || 1) || !actionReference(match[2]!):!actionReference(id);}))fail('В примере указано неизвестное действие');
    for(const values of [example.initial,example.expected,...(example.states || [])])for(const [key,entry] of Object.entries(values)) {const match=/^([1-9]\d{0,4}):(.+)$/.exec(key),fact=factMap.get(match?match[2]!:key);if(!fact || !(fact.type==='collection'?Array.isArray(entry):scalar(entry)) || match && (Number(match[1])>(spec.instances || 1) || fact.scope!=='instance'))fail('Неизвестное значение в примере');validateExpressionValues([fact],{[fact.id]:entry});}
  }
  if(!unique(spec.bindings,item=>`${item.blockId}\0${item.implementationId}`))fail('Привязка уже существует');
  for(const [index,binding] of spec.bindings.entries()) {if(!plain(binding))fail('Некорректная привязка');allowed(binding,['blockId','implementationId'],`bindings[${index}]`);if(!bindable.has(binding.blockId) || typeof binding.implementationId!=='string' || !/^[a-f0-9-]{36}$/i.test(binding.implementationId))fail('Неизвестный блок или реализация');}
  return spec;
}

type Transition={from:number[];to:number[];guard:Expression|null;inverse?:boolean;alternatives?:Expression[];action?:ActionBlock;choice?:{id:string;title:string;branchId:string;branchTitle:string;exclusive:boolean}};
type Net={start:number;end:number;transitions:Transition[]};
type Configuration={tokens:number[];values:Record<string,AlgorithmValue>;previous:number|null;step?:TraceStep;watches?:(string|null)[];observed?:boolean[]};
const literalTrue:Expression={op:'boolean',value:true};
const stateKey=(tokens:number[],values:Record<string,AlgorithmValue>,facts:Fact[],watches?:(string|null)[])=>JSON.stringify([tokens,...facts.map(fact=>values[fact.id]),...(watches?[watches]:[])]);

function incomplete(spec:BusinessProcess):ProcessIssue[] {
  const issues:ProcessIssue[]=[];const add=(title:string,blockId?:string)=>issues.push({kind:'incomplete',title,blockId});
  const hasHole=(expr:unknown):boolean=>{if(Array.isArray(expr))return expr.some(hasHole);if(!plain(expr))return false;if(expr.op==='hole' || expr.rounding==='unknown')return true;return Object.values(expr).some(hasHole);};
  if(!spec.steps.length)add('В процессе пока нет действий');
  for(const fact of spec.facts)if(fact.initial.kind==='unknown')add(`Начальное значение «${fact.title}» не определено`);
  const collectionHoles=(item:AlgorithmCollectionInput):void=>{for(const field of item.fields)if(field.type==='choice' && !field.options?.length)add(`Варианты поля «${field.title}» в списке «${item.title}» не определены`);else if(field.type==='collection')collectionHoles(field);};for(const fact of spec.facts)if(fact.type==='collection')collectionHoles(fact);
  const definitions=new Map(spec.definitions.map(item=>[item.id,item])),usedDefinitions=new Set<string>();
  const walk=(steps:Block[])=>{for(const block of steps) {
    if(block.kind==='action' && (!block.specified || block.guard===null || hasHole(block.guard) || block.changes.some(item=>hasHole(item.value))))add(`Действие «${block.title}» не определено полностью`,block.id);
    if(block.kind==='group' || block.kind==='repeat') {if(!block.steps.length || block.kind==='repeat' && (block.when===null || hasHole(block.when)))add(`Блок «${block.title}» не определён полностью`,block.id);walk(block.steps);}
    if(block.kind==='choice' || block.kind==='parallel') {if(block.branches.length<2)add(`В блоке «${block.title}» нужны ветви`,block.id);for(const branch of block.branches){if(!branch.steps.length || block.kind==='choice' && !(branch as ChoiceBranch).otherwise && ((branch as ChoiceBranch).when===null || hasHole((branch as ChoiceBranch).when)))add(`Ветвь «${branch.title}» не определена полностью`,branch.id);walk(branch.steps);}}
    if(block.kind==='use' && !usedDefinitions.has(block.definitionId)){usedDefinitions.add(block.definitionId);const definition=definitions.get(block.definitionId)!;if(!definition.steps.length)add(`Общий блок «${definition.title}» пуст`,definition.id);else walk(definition.steps);}
    if(block.kind==='call')add(`Общий блок «${block.title}» другого процесса ещё не раскрыт`,block.id);
  }};
  walk(spec.steps);
  for(const property of spec.properties)if(property.kind==='within' ? !property.startActionId || !property.endActionId || !property.clockFactId || property.withinSeconds===undefined : property.expr===null || hasHole(property.expr) || property.kind==='after' && !property.actionId)add(`Свойство «${property.title}» не определено`,property.id);
  return issues;
}

function compile(spec:BusinessProcess):Net {
  const transitions:Transition[]=[],definitions=new Map(spec.definitions.map(item=>[item.id,item]));let count=0;
  const place=()=>++count;
  const edge=(from:number[],to:number[],options:Partial<Transition>={})=>{if(transitions.length>=1500)fail('Слишком много переходов после раскрытия общих блоков');transitions.push({from,to,guard:literalTrue,...options});};
  const sequence=(steps:Block[],start:number,end:number):void=>{
    if(!steps.length){edge([start],[end]);return;}
    let cursor=start;for(let i=0;i<steps.length;i++){const next=i===steps.length-1?end:place();block(steps[i]!,cursor,next);cursor=next;}
  };
  const block=(item:Block,start:number,end:number):void=>{
    if(item.kind==='action') {edge([start],[end],{guard:item.guard,action:item});return;}
    if(item.kind==='group') {sequence(item.steps,start,end);return;}
    if(item.kind==='use') {sequence(definitions.get(item.definitionId)!.steps,start,end);return;}
    if(item.kind==='call')fail('Сначала загрузите общий блок другого процесса');
    if(item.kind==='repeat') {const a=place(),b=place();edge([start],[a],{guard:item.when});sequence(item.steps,a,b);edge([b],[start]);edge([start],[end],{guard:item.when,inverse:true});return;}
    if(item.kind==='choice') {
      const alternatives=item.branches.filter(branch=>!branch.otherwise && branch.when!==null).map(branch=>branch.when!);
      for(const branch of item.branches){const first=place();edge([start],[first],{guard:branch.when,alternatives:branch.otherwise?alternatives:undefined,choice:{id:item.id,title:item.title,branchId:branch.id,branchTitle:branch.title,exclusive:item.exclusive}});sequence(branch.steps,first,end);}return;
    }
    const ins=item.branches.map(()=>place()),outs=item.branches.map(()=>place());edge([start],ins);item.branches.forEach((branch,index)=>sequence(branch.steps,ins[index]!,outs[index]!));edge(outs,[end]);
  };
  const start=place(),end=place();sequence(spec.steps,start,end);return {start,end,transitions};
}

function domains(spec:BusinessProcess):{initial:Record<string,AlgorithmValue>[];reason?:string} {
  let combinations:Record<string,AlgorithmValue>[]=[{}];
  for(const fact of spec.facts) {
    let options:AlgorithmValue[];
    if(fact.initial.kind==='value')options=[fact.initial.value];
    else if(fact.type==='boolean')options=[false,true];
    else if(fact.type==='choice')options=fact.options || [];
    else if(fact.type==='date' && fact.domain) {const first=calendarDay(fact.domain.min),count=calendarDay(fact.domain.max)-first+1;if(count>MAX_INITIAL)return {initial:[],reason:`Область «${fact.title}» слишком велика для перебора`};options=Array.from({length:count},(_,i)=>calendarDate(first+i));}
    else if(fact.type==='instant' && fact.domain) {const first=instantSecond(fact.domain.min),count=instantSecond(fact.domain.max)-first+1;if(count>MAX_INITIAL)return {initial:[],reason:`Область «${fact.title}» слишком велика для перебора`};options=Array.from({length:count},(_,i)=>instantValue(first+i));}
    else if(fact.type==='integer' && fact.domain) {
      const count=BigInt(fact.domain.max)-BigInt(fact.domain.min)+1n;
      if(count>BigInt(MAX_INITIAL))return {initial:[],reason:`Область «${fact.title}» слишком велика для перебора`};
      options=Array.from({length:Number(count)},(_,i)=>(BigInt(fact.domain!.min)+BigInt(i)).toString());
    } else return {initial:[],reason:`Для «${fact.title}» не задана конечная область значений`};
    if(combinations.length*options.length>MAX_INITIAL)return {initial:[],reason:'Слишком много начальных сочетаний'};
    combinations=combinations.flatMap(previous=>options.map(entry=>({...previous,[fact.id]:entry})));
  }
  return {initial:combinations};
}

function enabled(transition:Transition,tokens:Set<number>,context:Map<string,unknown>):boolean {
  if(!transition.from.every(place=>tokens.has(place)))return false;
  const condition=transition.alternatives ? !transition.alternatives.some(expr=>evaluateExpression(expr,context)===true) : transition.guard!==null && evaluateExpression(transition.guard,context)===true;
  return transition.inverse ? !condition : condition;
}
function advance(spec:BusinessProcess,current:Configuration,transition:Transition):{tokens:number[];values:Record<string,AlgorithmValue>;step?:TraceStep} {
  const context=expressionContext(spec.facts,current.values),values={...current.values};
  // All changes of one business action observe the same previous state.
  for(const change of transition.action?.changes || [])values[change.factId]=evaluateExpression(change.value,context);
  expressionContext(spec.facts,values);
  const tokens=new Set(current.tokens);for(const from of transition.from)tokens.delete(from);for(const to of transition.to)tokens.add(to);
  const step=transition.action?{kind:'action' as const,id:transition.action.id,title:transition.action.title}:transition.choice?{kind:'branch' as const,id:transition.choice.branchId,title:transition.choice.branchTitle}:undefined;
  return {tokens:[...tokens].sort((a,b)=>a-b),values,step};
}
function traceAt(queue:Configuration[],index:number):TraceStep[] {const trace:TraceStep[]=[];let current:number|null=index;while(current!==null){const entry:Configuration=queue[current]!;if(entry.step)trace.push(entry.step);current=entry.previous;}return trace.reverse();}
function findCycle(reachable:Set<number>,adjacency:number[][],edgeSteps:(TraceStep|undefined)[][]):{start:number;steps:TraceStep[]}|null {
  const color=new Map<number,number>(),positions=new Map<number,number>();
  type Frame={id:number;next:number;incoming?:TraceStep};
  for(const start of reachable) {
    if(color.has(start))continue;
    const stack:Frame[]=[{id:start,next:0}];color.set(start,1);positions.set(start,0);
    while(stack.length) {
      const frame=stack[stack.length-1]!,edges=adjacency[frame.id]!;
      if(frame.next>=edges.length){color.set(frame.id,2);positions.delete(frame.id);stack.pop();continue;}
      const index=frame.next++,target=edges[index]!,step=edgeSteps[frame.id]![index];if(!reachable.has(target))continue;
      if(color.get(target)===1){const position=positions.get(target)!;return {start:target,steps:[...stack.slice(position+1).map(item=>item.incoming),step].filter((item):item is TraceStep=>!!item)};}
      if(!color.has(target)){color.set(target,1);positions.set(target,stack.length);stack.push({id:target,next:0,incoming:step});}
    }
  }
  return null;
}

export function sameFactValue(fact:Fact,first:AlgorithmValue,second:AlgorithmValue):boolean {
  const left=expressionContext([fact],{[fact.id]:first}).get(fact.id),right=expressionContext([fact],{[fact.id]:second}).get(fact.id);
  return evaluateExpression({op:'eq',args:[{op:'var',id:'left'},{op:'var',id:'right'}]},new Map([['left',left],['right',right]]))===true;
}

// Ignore every guard and state change: this only enlarges the set of paths.
// Therefore an impossible sequence is a real structural error, but a possible
// one is never evidence that an example passes with its actual values.
function impossibleExampleStructure(net:Net,example:Example):string|null {
  const key=(tokens:number[])=>tokens.join(',');
  const advanceTokens=(tokens:number[],edge:Transition)=>{
    const next=new Set(tokens);for(const from of edge.from)next.delete(from);for(const to of edge.to)next.add(to);return [...next].sort((a,b)=>a-b);
  };
  const closure=(start:number[][]):number[][]|null=>{
    const queue=[...start],seen=new Set(queue.map(key));
    for(let index=0;index<queue.length;index++){
      const tokens=queue[index]!,places=new Set(tokens);
      for(const edge of net.transitions)if(!edge.action && edge.from.every(place=>places.has(place))){
        const next=advanceTokens(tokens,edge),id=key(next);if(seen.has(id))continue;
        if(queue.length>=MAX_EXAMPLE_STATES)return null;seen.add(id);queue.push(next);
      }
    }
    return queue;
  };
  let current:number[][]=[[net.start]];
  for(const action of example.actions){
    const options=closure(current);if(!options)return null;
    const next:number[][]=[],seen=new Set<string>();
    for(const tokens of options){const places=new Set(tokens);for(const edge of net.transitions)if(edge.action?.id===action && edge.from.every(place=>places.has(place))){
      const candidate=advanceTokens(tokens,edge),id=key(candidate);if(seen.has(id))continue;
      if(next.length>=MAX_EXAMPLE_STATES)return null;seen.add(id);next.push(candidate);
    }}
    if(!next.length)return `Действие «${action}» невозможно в указанном порядке даже без учёта условий`;
    current=next;
  }
  if(example.completed){const options=closure(current);if(options && !options.some(tokens=>tokens.length===1 && tokens[0]===net.end))return 'Пример не может завершиться после указанных действий даже без учёта условий';}
  return null;
}

function incompleteExampleResults(spec:BusinessProcess):ProcessReport['examples'] {
  // Unknown initial data do not change the control-flow structure. Other
  // incomplete blocks might, so stay conservative and do not inspect them.
  const withUnknownDataAsAny={...spec,facts:spec.facts.map(fact=>fact.initial.kind==='unknown'?{...fact,initial:{kind:'any' as const}}:fact)};
  let net:Net|null=null;if(!incomplete(withUnknownDataAsAny).length)try{net=compile(spec);}catch{/* Unresolved structure remains unknown. */}
  return spec.examples.map(example=>{
    const detail=net?impossibleExampleStructure(net,example):null;
    return detail?{id:example.id,title:example.title,status:'failed',detail}:{id:example.id,title:example.title,status:'unknown',detail:'Модель содержит неопределённые блоки или данные'};
  });
}

function checkExample(spec:BusinessProcess,net:Net,example:Example):{id:string;title:string;status:'passed'|'failed'|'unknown';detail:string} {
  const result=(status:'passed'|'failed'|'unknown',detail:string)=>({id:example.id,title:example.title,status,detail});
  const values:Record<string,AlgorithmValue>={};
  try {for(const fact of spec.facts){const supplied=example.initial[fact.id];if(supplied!==undefined && fact.initial.kind==='value' && !sameFactValue(fact,supplied,fact.initial.value))return result('failed',`Начальное значение «${fact.title}» противоречит модели`);const initial=supplied ?? (fact.initial.kind==='value'?fact.initial.value:undefined);if(initial===undefined){const structural=impossibleExampleStructure(net,example);return structural?result('failed',structural):result('unknown',`Укажите начальное значение «${fact.title}»`);}values[fact.id]=initial;}}catch(error){return result('unknown',error instanceof Error?error.message:'Не удалось проверить начальные данные');}
  const deadlines=spec.properties.filter(property=>property.kind==='within'),eventual=spec.properties.filter(property=>property.kind==='eventually');
  const evaluateAt=(property:Property,state:Record<string,AlgorithmValue>)=>property.expr && evaluateExpression(property.expr,expressionContext(spec.facts,state))===true;
  try {
    expressionContext(spec.facts,values);
    const initialViolation=spec.properties.find(property=>property.kind==='always' && !evaluateAt(property,values));
    if(initialViolation)return result('failed',`Начальное состояние нарушает свойство «${initialViolation.title}»`);
    const observed=eventual.map(property=>!!evaluateAt(property,values)),watches=deadlines.map(()=>null);
    let current:Configuration[]=[{tokens:[net.start],values,previous:null,watches,observed}];
    const key=(item:Configuration)=>`${stateKey(item.tokens,item.values,spec.facts,item.watches)}:${JSON.stringify(item.observed)}`;
    const closure=(start:Configuration[]):Configuration[]=>{
      const queue=[...start],seen=new Set(queue.map(key));
      for(let i=0;i<queue.length;i++){const item=queue[i]!,context=expressionContext(spec.facts,item.values),tokens=new Set(item.tokens);for(const edge of net.transitions)if(!edge.action && enabled(edge,tokens,context)){const next:Configuration={...advance(spec,item,edge),previous:null,watches:item.watches,observed:item.observed},id=key(next);if(!seen.has(id)){if(queue.length>=MAX_EXAMPLE_STATES)throw new Error('Слишком много вариантов примера');seen.add(id);queue.push(next);}}}
      return queue;
    };
    for(let index=0;index<example.actions.length;index++) {
      const id=example.actions[index]!,next:Configuration[]=[];let possible=false,matching=false,failedProperty='',clockError=false;
      for(const item of closure(current)) {
        const context=expressionContext(spec.facts,item.values),tokens=new Set(item.tokens);
        for(const edge of net.transitions)if(edge.action?.id===id && enabled(edge,tokens,context)) {
          possible=true;const step=advance(spec,item,edge),observation=example.states?.[index];
          if(observation && !Object.entries(observation).every(([fact,value])=>sameFactValue(spec.facts.find(entry=>entry.id===fact)!,step.values[fact]!,value)))continue;
          matching=true;let violation='';
          for(const property of spec.properties)if((property.kind==='always' || property.kind==='after' && property.actionId===id) && !evaluateAt(property,step.values)){violation=property.title;break;}
          const nextWatches=[...(item.watches || [])];
          for(let watch=0;watch<deadlines.length && !violation;watch++) {
            const property=deadlines[watch]!,clock=property.clockFactId!,before=instantSecond(item.values[clock]),after=instantSecond(step.values[clock]);
            if(after<before){clockError=true;violation=property.title;break;}
            if(id===property.startActionId && nextWatches[watch]===null)nextWatches[watch]=String(step.values[clock]);
            const start=nextWatches[watch];if(start!=null && after-instantSecond(start)>Number(property.withinSeconds)){violation=property.title;break;}
            if(id===property.endActionId && start!=null)nextWatches[watch]=null;
          }
          if(violation){failedProperty ||= violation;continue;}
          const nextObserved=eventual.map((property,n)=>!!item.observed?.[n] || !!evaluateAt(property,step.values));
          next.push({...step,previous:null,watches:nextWatches,observed:nextObserved});
        }
      }
      if(!possible)return result('failed',`Действие «${id}» недоступно в этом примере`);
      if(!matching)return result('failed',`Состояние после действия «${id}» не соответствует модели`);
      if(!next.length)return clockError?result('unknown','Время в наблюдении движется назад'):result('failed',`После действия «${id}» нарушается свойство «${failedProperty}»`);
      current=next;if(current.length>MAX_EXAMPLE_STATES)return result('unknown','Слишком много вариантов примера');
    }
    const outcomes=closure(current),matching=outcomes.filter(item=>Object.entries(example.expected).every(([id,value])=>sameFactValue(spec.facts.find(fact=>fact.id===id)!,item.values[id]!,value)) && (!example.completed || item.tokens.length===1 && item.tokens[0]===net.end));
    if(!matching.length)return result('failed','Указанный результат не найден');
    if(example.completed && !matching.some(item=>(item.watches || []).every(value=>value===null) && (item.observed || []).every(Boolean)))return result('failed','Завершённый путь не выполнил срок или свойство достижения');
    const pending=!example.completed && matching.every(item=>(item.watches || []).some(value=>value!==null) || (item.observed || []).some(value=>!value));
    return result('passed',pending?'Путь возможен; срок или свойство достижения ещё не завершены':'Такой путь и результат возможны в модели');
  }catch(error){return result('unknown',error instanceof Error?error.message:'Не удалось проверить пример');}
}

// Check one observed execution without claiming that unobserved executions,
// the adapter, or an entire implementation have been verified.
export function checkBusinessTrace(value:unknown,example:Example):ProcessReport['examples'][number] {
  if(!plain(value))fail('Некорректная модель процесса');
  const spec=validateBusinessProcess({...value,examples:[example]});
  const result=(detail:string)=>({id:example.id,title:example.title,status:'unknown' as const,detail});
  if((spec.instances || 1)>1 || JSON.stringify([spec.steps,spec.definitions,spec.properties]).match(/"op":"(?:all_instances|any_instances|at_most_one_instance|count_instances)"/))return result('Для этой проверки сначала разверните одновременные запуски');
  if(incomplete(spec).length)return incompleteExampleResults(spec)[0] || result('Модель содержит неопределённые блоки или нераскрытые вызовы');
  try{return checkExample(spec,compile(spec),example);}catch(error){return result(error instanceof Error?error.message:'Не удалось проверить путь');}
}

export type GeneratedExamples={examples:Example[];states:number;transitions:number;completeStates:boolean;modelConflicts:number;unknownPaths:number;problems:{status:'failed'|'unknown';detail:string;actions:string[];initial:Record<string,AlgorithmValue>}[];reason?:string};

// Produce bounded executable paths for implementation tests. This traverses
// the same transition system as the checker; it is not a coverage proof.
export function generateBusinessExamples(value:unknown,options:{maxCases?:number;maxStates?:number;maxActions?:number}={}):GeneratedExamples {
  const spec=validateBusinessProcess(value),maxCases=options.maxCases ?? 32,maxStates=options.maxStates ?? 1000,maxActions=options.maxActions ?? 12;
  if(!Number.isSafeInteger(maxCases) || maxCases<1 || maxCases>64 || !Number.isSafeInteger(maxStates) || maxStates<1 || maxStates>5000 || !Number.isSafeInteger(maxActions) || maxActions<1 || maxActions>32)fail('Некорректный предел генерации примеров');
  const empty=(reason:string):GeneratedExamples=>({examples:[],states:0,transitions:0,completeStates:false,modelConflicts:0,unknownPaths:0,problems:[],reason});
  if((spec.instances || 1)>1 || JSON.stringify([spec.steps,spec.definitions,spec.properties]).match(/"op":"(?:all_instances|any_instances|at_most_one_instance|count_instances)"/))return empty('Сначала разверните одновременные запуски');
  if(incomplete(spec).length)return empty('Модель содержит неопределённые блоки или нераскрытые вызовы');
  const space=domains(spec);if(space.reason)return empty(space.reason);
  let net:Net;try{net=compile(spec);}catch(error){return empty(error instanceof Error?error.message:'Не удалось раскрыть процесс');}
  const used=new Set<string>();const collect=(item:unknown):void=>{if(Array.isArray(item)){item.forEach(collect);return;}if(plain(item)){if(typeof item.id==='string')used.add(item.id);Object.values(item).forEach(collect);}};collect(spec);
  const nextId=()=>{let index=used.size+1,id=`generated_${index}`;while(used.has(id))id=`generated_${++index}`;used.add(id);return id;};
  type Node={current:Configuration;initial:Record<string,AlgorithmValue>;actions:string[];states:Record<string,AlgorithmValue>[]};
  const queue:Node[]=[],seen=new Set<string>(),caseKeys=new Set<string>(),examples:Example[]=[],problems:GeneratedExamples['problems']=[];let transitions=0,modelConflicts=0,unknownPaths=0,truncated=false,reason='';
  const enqueue=(node:Node)=>{const key=JSON.stringify([node.initial,stateKey(node.current.tokens,node.current.values,spec.facts)]);if(seen.has(key))return;if(queue.length>=maxStates){truncated=true;return;}seen.add(key);queue.push(node);};
  for(const initial of space.initial)enqueue({current:{tokens:[net.start],values:initial,previous:null},initial,actions:[],states:[]});
  for(let index=0;index<queue.length && examples.length<maxCases;index++){
    const item=queue[index]!,tokens=new Set(item.current.tokens);let context:Map<string,unknown>;
    try{context=expressionContext(spec.facts,item.current.values);}catch(error){truncated=true;reason=error instanceof Error?error.message:'Не удалось вычислить начальные данные';break;}
    for(const edge of net.transitions){
      let available:boolean;try{available=enabled(edge,tokens,context);}catch(error){truncated=true;reason=error instanceof Error?error.message:'Не удалось вычислить условие';break;}if(!available)continue;
      if(edge.action && item.actions.length>=maxActions){truncated=true;continue;}
      let next:ReturnType<typeof advance>;try{next=advance(spec,item.current,edge);}catch(error){truncated=true;reason=error instanceof Error?error.message:'Не удалось выполнить действие модели';continue;}
      transitions++;const actions=edge.action?[...item.actions,edge.action.id]:item.actions,states=edge.action?[...item.states,next.values]:item.states;
      if(edge.action){const key=JSON.stringify([item.initial,actions,states]);if(!caseKeys.has(key)){
        caseKeys.add(key);const example:Example={id:nextId(),title:`Путь ${examples.length+1}: ${edge.action.title}`.slice(0,180),initial:item.initial,actions,states,expected:next.values,completed:false};
        try{const checked=checkBusinessTrace(spec,example);if(checked.status==='passed')examples.push(example);else {if(checked.status==='failed')modelConflicts++;else unknownPaths++;if(problems.length<16)problems.push({status:checked.status,detail:checked.detail,actions,initial:item.initial});truncated=true;}}
        catch(error){unknownPaths++;if(problems.length<16)problems.push({status:'unknown',detail:error instanceof Error?error.message:'Не удалось проверить путь',actions,initial:item.initial});truncated=true;}
      }}
      enqueue({current:{...next,previous:null},initial:item.initial,actions,states});
      if(examples.length>=maxCases){truncated=true;break;}
    }
  }
  return {examples,states:queue.length,transitions,completeStates:!truncated,modelConflicts,unknownPaths,problems,...(reason?{reason}:{})};
}

export type RefinementMapping={facts:Record<string,string>;actions:Record<string,string|null>};
export type RefinementReport={status:'verified'|'violated'|'unknown';reason:string;states:number;transitions:number;trace?:TraceStep[];implementationFacts?:Record<string,AlgorithmValue>;scope:string};

/** Trace inclusion of two finite formal models under an explicit observation
 * mapping. The implementation model is not the implementation's source code. */
export function checkBusinessRefinement(businessValue:unknown,implementationValue:unknown,mapping:RefinementMapping,options:{maxStates?:number;timeoutMs?:number}={}):RefinementReport {
  const business=validateBusinessProcess(businessValue),implementation=validateBusinessProcess(implementationValue),maxStates=options.maxStates ?? 2500,timeout=options.timeoutMs ?? 2000;
  if(!Number.isSafeInteger(maxStates) || maxStates<1 || maxStates>5000 || !Number.isSafeInteger(timeout) || timeout<100 || timeout>10000)fail('Некорректный предел проверки соответствия');
  if(!plain(mapping) || !plain(mapping.facts) || !plain(mapping.actions) || Object.keys(mapping).some(key=>!['facts','actions'].includes(key)))fail('Укажите сопоставление действий и значений');
  const getActions=(model:BusinessProcess)=>{const result=new Set<string>(),visit=(steps:Block[])=>{for(const item of steps){if(item.kind==='action')result.add(item.id);else if(item.kind==='group' || item.kind==='repeat')visit(item.steps);else if(item.kind==='choice' || item.kind==='parallel')item.branches.forEach(branch=>visit(branch.steps));}};visit(model.steps);model.definitions.forEach(item=>visit(item.steps));return result;};
  const businessActions=getActions(business),implementationActions=getActions(implementation),businessFacts=new Map(business.facts.map(fact=>[fact.id,fact])),implementationFacts=new Map(implementation.facts.map(fact=>[fact.id,fact]));
  if(Object.keys(mapping.facts).length!==businessFacts.size || business.facts.some(fact=>typeof mapping.facts[fact.id]!=='string' || !implementationFacts.has(mapping.facts[fact.id]!)))fail('Сопоставьте все значения бизнес-модели с реализацией');
  if(Object.keys(mapping.actions).length!==implementationActions.size || [...implementationActions].some(id=>!Object.hasOwn(mapping.actions,id) || mapping.actions[id]!==null && (typeof mapping.actions[id]!=='string' || !businessActions.has(mapping.actions[id]!))))fail('Сопоставьте все действия реализации или обозначьте их внутренними');
  const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value;
  const signature=(fact:Fact):string=>JSON.stringify(stable(fact.type==='collection'?{type:fact.type,fields:fact.fields.map(field=>signature(field as Fact))}:fact.type==='data'?{type:fact.type,schema:dataDefinitionsKey(fact.dataSchema)}:{type:fact.type,unit:fact.unit || '',options:fact.type==='choice'?[...(fact.options || [])].sort():undefined}));
  for(const fact of business.facts)if(signature(fact)!==signature(implementationFacts.get(mapping.facts[fact.id]!)!))fail(`Типы значения «${fact.title}» не совпадают`);
  const scope='Сравнение двух формальных моделей при указанном сопоставлении: только конечные начальные области и достижимые пути. Завершение, отсутствие ошибок, правильность бизнес-требований и соответствие модели реальному коду отдельно не доказаны.';
  let stateCount=0,transitionCount=0;const result=(status:RefinementReport['status'],reason:string,extra:Partial<RefinementReport>={}):RefinementReport=>({status,reason,states:stateCount,transitions:transitionCount,scope,...extra});
  if((business.instances || 1)>1 || (implementation.instances || 1)>1 || JSON.stringify([business.steps,business.properties,implementation.steps,implementation.properties]).match(/"op":"(?:all_instances|any_instances|at_most_one_instance|count_instances)"/))return result('unknown','Одновременные запуски в этом сравнении пока не раскрываются');
  if(incomplete(business).length || incomplete(implementation).length)return result('unknown','В одной из моделей есть неопределённые блоки или нераскрытые вызовы');
  const bDomain=domains(business),iDomain=domains(implementation);if(bDomain.reason || iDomain.reason)return result('unknown',bDomain.reason || iDomain.reason || 'Не задана конечная область');
  if(!bDomain.initial.length || !iDomain.initial.length)return result('unknown','Нет допустимых начальных значений');
  let bNet:Net,iNet:Net;try{bNet=compile(business);iNet=compile(implementation);}catch(error){return result('unknown',error instanceof Error?error.message:'Не удалось раскрыть модели');}
  const deadline=Date.now()+timeout,match=(b:Record<string,AlgorithmValue>,i:Record<string,AlgorithmValue>):boolean=>business.facts.every(fact=>{try{return sameFactValue(fact,b[fact.id]!,i[mapping.facts[fact.id]!]!);}catch{return false;}});
  const key=(net:BusinessProcess,item:Configuration)=>stateKey(item.tokens,item.values,net.facts);
  const closure=(initial:Configuration[]):Configuration[]=>{
    const queue:Configuration[]=[],seen=new Set<string>();const add=(item:Configuration)=>{const k=key(business,item);if(!seen.has(k)){if(queue.length>=maxStates)throw new Error('Превышен предел состояний бизнес-модели');seen.add(k);queue.push(item);}};initial.forEach(add);
    for(let index=0;index<queue.length;index++){if(Date.now()>deadline)throw new Error('Превышено время проверки');const current=queue[index]!,context=expressionContext(business.facts,current.values),tokens=new Set(current.tokens);for(const edge of bNet.transitions)if(!edge.action && enabled(edge,tokens,context))add({...advance(business,current,edge),previous:null});}
    return queue;
  };
  type Pair={implementation:Configuration;business:Configuration[];trace:TraceStep[]};
  const queue:Pair[]=[],seen=new Set<string>();
  const add=(pair:Pair)=>{const bKeys=pair.business.map(item=>key(business,item)).sort(),k=JSON.stringify([key(implementation,pair.implementation),bKeys]);if(seen.has(k))return;if(queue.length>=maxStates)throw new Error('Превышен предел состояний сравнения');seen.add(k);queue.push(pair);};
  try{
    const bInitial=bDomain.initial.map(values=>({tokens:[bNet.start],values,previous:null}));
    for(const values of iDomain.initial){if(Date.now()>deadline)throw new Error('Превышено время проверки');const compatible=bInitial.filter(item=>match(item.values,values));if(!compatible.length)return result('violated','Начальное состояние реализации не допускается бизнес-моделью',{trace:[],implementationFacts:values});add({implementation:{tokens:[iNet.start],values,previous:null},business:closure(compatible),trace:[]});}
    for(let index=0;index<queue.length;index++){
      if(Date.now()>deadline)throw new Error('Превышено время проверки');const pair=queue[index]!,current=pair.implementation,context=expressionContext(implementation.facts,current.values),tokens=new Set(current.tokens);stateCount++;
      if(current.tokens.length===1 && current.tokens[0]===iNet.end && !pair.business.some(item=>item.tokens.length===1 && item.tokens[0]===bNet.end))return result('violated','Реализация завершилась до допустимого завершения бизнес-процесса',{trace:pair.trace,implementationFacts:current.values});
      for(const edge of iNet.transitions){if(!enabled(edge,tokens,context))continue;const next=advance(implementation,current,edge),step=next.step,trace=step?.kind==='action'?[...pair.trace,step]:pair.trace;if(trace.length>512)throw new Error('Превышена длина исследуемого пути');transitionCount++;
        if(!edge.action || mapping.actions[edge.action.id]===null){
          if(!pair.business.some(item=>match(item.values,next.values)))return result('violated','Внутреннее действие изменило наблюдаемые бизнес-значения',{trace,implementationFacts:next.values});
          add({implementation:{...next,previous:null},business:pair.business.filter(item=>match(item.values,next.values)),trace});continue;
        }
        const target=mapping.actions[edge.action.id]!,matches:Configuration[]=[];
        for(const candidate of pair.business){const bContext=expressionContext(business.facts,candidate.values),bTokens=new Set(candidate.tokens);for(const bEdge of bNet.transitions)if(bEdge.action?.id===target && enabled(bEdge,bTokens,bContext)){const after=advance(business,candidate,bEdge);if(match(after.values,next.values))matches.push({...after,previous:null});}}
        if(!matches.length)return result('violated','Действие или его результат не допускаются бизнес-моделью',{trace,implementationFacts:next.values});
        add({implementation:{...next,previous:null},business:closure(matches),trace});
      }
    }
    return result('verified','Все достижимые пути формальной модели реализации допускаются бизнес-моделью');
  }catch(error){return result('unknown',error instanceof Error?error.message:'Сравнение не завершено');}
}

export function checkBusinessProcess(value:unknown):ProcessReport {
  const spec=validateBusinessProcess(value);
  const hasQuantifier=JSON.stringify([spec.steps,spec.definitions,spec.properties]).match(/"op":"(?:all_instances|any_instances|at_most_one_instance|count_instances)"/);
  const hasScopedExamples=spec.examples.some(example=>[...example.actions,...Object.keys(example.initial),...Object.keys(example.expected),...(example.states || []).flatMap(Object.keys)].some(key=>/^[1-9]\d{0,4}:/.test(key)));
  if((spec.instances || 1)>1 || hasQuantifier || hasScopedExamples) {
    try {const expanded=expandProcessInstances(spec);return translateInstanceReport(spec,expanded,checkBusinessProcess(expanded.model));}
    catch(error){const reason=error instanceof Error?error.message:'Не удалось развернуть параллельные запуски';return {complete:false,scope:{initial:0,states:0,transitions:0,domains:[],semantics:'Проверка нескольких запусков не завершена.'},properties:spec.properties.map(property=>({id:property.id,title:property.title,kind:property.kind,status:'unknown',reason})),issues:[],examples:spec.examples.map(example=>({id:example.id,title:example.title,status:'unknown',detail:reason})),reason};}
  }
  const holes=incomplete(spec),scope={initial:0,states:0,transitions:0,domains:spec.facts.map(({id,title,type,initial,domain,options})=>({id,title,type,initial,...(domain?{domain}:{}),...(options?{options}:{})})),semantics:`Один экземпляр процесса; параллельные ветви выполняются с любым чередованием действий. ${spec.assumptions.progress==='may_wait'?'Среда может не выполнить действие.':'Предполагается, что процесс всегда делает доступный шаг; справедливость отдельных ветвей не предполагается.'} Внешние действия входят только если описаны в модели.`};
  const results=spec.properties.map(property=>({id:property.id,title:property.title,kind:property.kind,status:'unknown' as const}));
  if(holes.length)return {complete:false,scope,properties:results,issues:holes,examples:incompleteExampleResults(spec),reason:'Модель не определена полностью'};
  let net:Net;try{net=compile(spec);}catch(error){return {complete:false,scope,properties:results,issues:[],examples:[],reason:error instanceof Error?error.message:'Не удалось раскрыть составные блоки'};}
  const examples=spec.examples.map(example=>checkExample(spec,net,example)),space=domains(spec);
  if(space.reason){const counterexamples=findInitialCounterexamples(spec),properties=proveUniversalInvariants(spec).map(property=>counterexamples.get(property.id) || property);if(properties.some(property=>property.status==='verified'))scope.semantics+=' Отдельные инварианты доказаны по диапазонам или индукцией без перебора; достижимость и ошибки действий не исследованы.';if(counterexamples.size)scope.semantics+=' Нарушения подтверждены отдельными начальными состояниями, остальные не исследованы полностью.';return addFractionalProofs(spec,{complete:false,scope,properties,issues:[],examples,reason:space.reason});}
  const deadlines=spec.properties.filter(property=>property.kind==='within');
  if(deadlines.length)scope.semantics+=' Время изменяется только описанными действиями; соответствие реальному времени не проверяется.';
  const queue:Configuration[]=[],indexes=new Map<string,number>(),adjacency:number[][]=[],edgeSteps:(TraceStep|undefined)[][]=[],actionAvailable:boolean[]=[],afterHits=new Map<string,number>(),violations=new Map<string,{facts:Record<string,AlgorithmValue>;trace:TraceStep[];reason:string}>(),issues:ProcessIssue[]=[],issueKeys=new Set<string>();
  const addIssue=(key:string,issue:ProcessIssue)=>{if(!issueKeys.has(key)){issueKeys.add(key);issues.push(issue);}};
  for(const values of space.initial) {const watches=deadlines.length?deadlines.map(()=>null):undefined,item={tokens:[net.start],values,previous:null,watches},key=stateKey(item.tokens,item.values,spec.facts,watches);if(!indexes.has(key)){indexes.set(key,queue.length);queue.push(item);adjacency.push([]);edgeSteps.push([]);}}
  scope.initial=queue.length;let complete=true,reason='';
  for(let i=0;i<queue.length && complete;i++) {
    const current=queue[i]!,tokens=new Set(current.tokens);let context:Map<string,unknown>;
    try{context=expressionContext(spec.facts,current.values);}catch(error){complete=false;reason=error instanceof Error?error.message:'Некорректное состояние';break;}
    try {
      for(const property of spec.properties)if(property.kind==='always' && property.expr && !violations.has(property.id) && evaluateExpression(property.expr,context)!==true)violations.set(property.id,{facts:current.values,trace:traceAt(queue,i),reason:'Свойство нарушено в достижимом состоянии'});
      const available=net.transitions.filter(edge=>enabled(edge,tokens,context));
      actionAvailable[i]=available.some(edge=>!!edge.action);
      const choices=new Map<string,Transition[]>();for(const edge of available)if(edge.choice?.exclusive){const key=`${edge.choice.id}:${edge.from.join(',')}`,list=choices.get(key) || [];list.push(edge);choices.set(key,list);}
      for(const [key,edges] of choices)if(edges.length>1)addIssue(`overlap:${key}`,{kind:'overlap',title:`Одновременно подходят несколько ветвей: ${edges[0]!.choice!.title}`,blockId:edges[0]!.choice!.id,facts:current.values,trace:traceAt(queue,i),detail:edges.map(edge=>edge.choice!.branchTitle).join(' · ')});
      for(const edge of net.transitions)if(edge.choice && edge.from.every(place=>tokens.has(place)) && !available.some(item=>item.choice?.id===edge.choice?.id && item.from.join(',')===edge.from.join(',')))addIssue(`uncovered:${edge.choice.id}:${edge.from.join(',')}`,{kind:'uncovered',title:`Ни одна ветвь не подходит: ${edge.choice.title}`,blockId:edge.choice.id,facts:current.values,trace:traceAt(queue,i)});
      if(!available.length && !(current.tokens.length===1 && current.tokens[0]===net.end))addIssue(`deadlock:${current.tokens.join(',')}`,{kind:'deadlock',title:'Процесс остановился до результата',facts:current.values,trace:traceAt(queue,i)});
      for(const edge of available) {
        let next:ReturnType<typeof advance>;try{next=advance(spec,current,edge);}catch(error){complete=false;reason=`Выход за область модели или ошибка вычисления: ${error instanceof Error?error.message:'неизвестно'}`;break;}
        scope.transitions++;
        if(edge.action)for(const property of spec.properties)if(property.kind==='after' && property.actionId===edge.action.id && property.expr){afterHits.set(property.id,(afterHits.get(property.id)||0)+1);if(!violations.has(property.id) && evaluateExpression(property.expr,expressionContext(spec.facts,next.values))!==true)violations.set(property.id,{facts:next.values,trace:[...traceAt(queue,i),next.step!],reason:'Свойство не выполняется после действия'});}
        const watches=current.watches ? [...current.watches] : undefined;
        for(let watch=0;watch<deadlines.length;watch++) {
          const property=deadlines[watch]!,clock=property.clockFactId!,before=instantSecond(current.values[clock]),after=instantSecond(next.values[clock]);
          if(after<before){complete=false;reason=`Время «${spec.facts.find(fact=>fact.id===clock)?.title || clock}» движется назад`;break;}
          if(edge.action?.id===property.startActionId){afterHits.set(property.id,(afterHits.get(property.id)||0)+1);if(watches![watch]===null)watches![watch]=String(next.values[clock]);}
          const started=watches![watch];if(started!==null && started!==undefined && after-instantSecond(started)>Number(property.withinSeconds) && !violations.has(property.id))violations.set(property.id,{facts:next.values,trace:[...traceAt(queue,i),...(next.step?[next.step]:[])],reason:`Срок ${property.withinSeconds} с превышен до завершения`});
          if(edge.action?.id===property.endActionId && started!==null && started!==undefined)watches![watch]=null;
        }
        if(!complete)break;
        const key=stateKey(next.tokens,next.values,spec.facts,watches);let target=indexes.get(key);
        if(target===undefined){if(queue.length>=MAX_STATES){complete=false;reason=`Превышен предел проверки: ${MAX_STATES} состояний`;break;}target=queue.length;indexes.set(key,target);queue.push({...next,watches,previous:i});adjacency.push([]);edgeSteps.push([]);}
        adjacency[i]!.push(target);edgeSteps[i]!.push(next.step);
      }
    }catch(error){complete=false;reason=error instanceof Error?error.message:'Не удалось вычислить условие';}
  }
  scope.states=queue.length;
  // Eventually = all paths from every initial state reach the property, with no
  // assumed fairness. A reachable non-matching terminal or cycle refutes it.
  try {if(complete)for(const property of spec.properties)if(property.kind==='eventually' && property.expr) {
    const reachable=new Set<number>(),pending:number[]=[];
    for(let i=0;i<scope.initial;i++)if(evaluateExpression(property.expr,expressionContext(spec.facts,queue[i]!.values))!==true){reachable.add(i);pending.push(i);}
    for(let cursor=0;cursor<pending.length;cursor++){const id=pending[cursor]!;for(const next of adjacency[id]!)if(!reachable.has(next) && evaluateExpression(property.expr,expressionContext(spec.facts,queue[next]!.values))!==true){reachable.add(next);pending.push(next);}}
    const waiting=spec.assumptions.progress==='may_wait'?[...reachable].find(id=>actionAvailable[id]):undefined;
    if(waiting!==undefined){violations.set(property.id,{facts:queue[waiting]!.values,trace:traceAt(queue,waiting),reason:'Среда может не выполнить доступное действие; гарантия прогресса не задана'});continue;}
    const terminal=[...reachable].find(id=>adjacency[id]!.length===0);
    if(terminal!==undefined){violations.set(property.id,{facts:queue[terminal]!.values,trace:traceAt(queue,terminal),reason:'Есть завершающийся или остановившийся путь без результата'});continue;}
    const cycle=findCycle(reachable,adjacency,edgeSteps);if(cycle)violations.set(property.id,{facts:queue[cycle.start]!.values,trace:[...traceAt(queue,cycle.start),...cycle.steps],reason:'Возможно бесконечное повторение показанного цикла без результата; предположения о справедливости не заданы'});
  }} catch(error){complete=false;reason=error instanceof Error?error.message:'Не удалось проверить достижение';}
  if(complete)for(let watch=0;watch<deadlines.length;watch++) {
    const property=deadlines[watch]!;if(violations.has(property.id))continue;
    const pending=new Set<number>();queue.forEach((item,index)=>{if(item.watches?.[watch]!=null)pending.add(index);});
    const waiting=spec.assumptions.progress==='may_wait'?[...pending].find(id=>actionAvailable[id]):undefined;
    if(waiting!==undefined){violations.set(property.id,{facts:queue[waiting]!.values,trace:traceAt(queue,waiting),reason:'Доступное действие может бесконечно ожидать; срок не гарантирован'});continue;}
    const terminal=[...pending].find(id=>adjacency[id]!.length===0);if(terminal!==undefined){violations.set(property.id,{facts:queue[terminal]!.values,trace:traceAt(queue,terminal),reason:'Процесс остановился, не завершив действие в срок'});continue;}
    const cycle=findCycle(pending,adjacency,edgeSteps);if(cycle)violations.set(property.id,{facts:queue[cycle.start]!.values,trace:[...traceAt(queue,cycle.start),...cycle.steps],reason:'Возможно бесконечное выполнение без завершения в срок'});
  }
  const report:ProcessReport={complete,scope,properties:spec.properties.map(property=>{
    const violation=violations.get(property.id);if(violation)return {id:property.id,title:property.title,kind:property.kind,status:'violated',...violation};
    if(!complete)return {id:property.id,title:property.title,kind:property.kind,status:'unknown',reason};
    if(['after','within'].includes(property.kind) && !afterHits.get(property.id))return {id:property.id,title:property.title,kind:property.kind,status:'not_applicable',reason:'Начальное действие недостижимо в этой модели'};
    return {id:property.id,title:property.title,kind:property.kind,status:'verified'};
  }),issues,examples,...(reason?{reason}:{})};
  // A bound on reachability does not prevent an independent inductive proof.
  // Other failures can indicate a concrete runtime error and remain untouched.
  return !complete && reason.startsWith('Превышен предел проверки:') ? addFractionalProofs(spec,report) : report;
}
