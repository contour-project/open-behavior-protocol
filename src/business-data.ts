/** Recursive, finite data types. A recursive occurrence is a named `ref`;
 * values themselves are finite JSON trees, with decimal numbers kept as text. */
export type DataType =
  | {kind:'null'|'boolean'|'text'|'integer'|'decimal'|'json'}
  | {kind:'literal';value:null|boolean|string}
  | {kind:'optional';of:DataType}
  | {kind:'list';item:DataType}
  | {kind:'record';fields:DataField[];allowExtra?:boolean}
  | {kind:'variant';variants:{tag:string;type:DataType}[]}
  | {kind:'ref';name:string};
export type DataField={name:string;type:DataType;optional?:boolean};
export type DataDefinitions={definitions:{name:string;type:DataType}[];root:DataType};
export type DataLimits={maxDepth?:number;maxNodes?:number;maxTextLength?:number};
export type DataValidation={status:'valid'}|{status:'invalid'|'unknown';path:string;reason:string};

const namePattern=/^[a-z][a-z0-9_]{0,63}$/;
const integerPattern=/^-?(?:0|[1-9]\d*)$/;
const decimalPattern=/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const fractionPattern=/^-?(?:0|[1-9]\d*)\/[1-9]\d*$/;
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value) && (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null);
const hasOnly=(value:object,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
function invalidSchema(reason:string):never {throw new Error(`Некорректный тип данных: ${reason}`);}

type Registry=Map<string,DataType>;
function inspectType(root:unknown,names:Set<string>):void {
  type Item={value:unknown;depth:number;leave?:boolean};const pending:Item[]=[{value:root,depth:0}],active=new WeakSet<object>();let count=0;
  while(pending.length){const item=pending.pop()!,value=item.value;if(!object(value))invalidSchema('описание должно быть объектом');if(item.leave){active.delete(value);continue;}
    if(active.has(value))invalidSchema('используйте именованные ссылки вместо цикла объектов');if(++count>20_000 || item.depth>256)invalidSchema('слишком большое описание');active.add(value);pending.push({value,depth:item.depth,leave:true});
    const kind=value.kind;
    if(['null','boolean','text','integer','decimal','json'].includes(String(kind))){if(!hasOnly(value,['kind']))invalidSchema('лишнее поле');continue;}
    if(kind==='literal'){if(!hasOnly(value,['kind','value']) || !Object.hasOwn(value,'value') || value.value!==null && typeof value.value!=='boolean' && typeof value.value!=='string')invalidSchema('некорректный литерал');continue;}
    if(kind==='ref'){if(!hasOnly(value,['kind','name']) || typeof value.name!=='string' || !names.has(value.name))invalidSchema('ссылка на неизвестный тип');continue;}
    if(kind==='optional'){if(!hasOnly(value,['kind','of']))invalidSchema('лишнее поле');pending.push({value:value.of,depth:item.depth+1});continue;}
    if(kind==='list'){if(!hasOnly(value,['kind','item']))invalidSchema('лишнее поле');pending.push({value:value.item,depth:item.depth+1});continue;}
    if(kind==='record'){
      if(!hasOnly(value,['kind','fields','allowExtra']) || !Array.isArray(value.fields) || value.fields.length>256 || value.allowExtra!==undefined && typeof value.allowExtra!=='boolean')invalidSchema('некорректные поля записи');
      const seen=new Set<string>();for(const field of value.fields){if(!object(field) || !hasOnly(field,['name','type','optional']) || typeof field.name!=='string' || !field.name || field.name.length>120 || seen.has(field.name) || field.optional!==undefined && typeof field.optional!=='boolean')invalidSchema('некорректное или повторное поле');seen.add(field.name);pending.push({value:field.type,depth:item.depth+1});}continue;
    }
    if(kind==='variant'){
      if(!hasOnly(value,['kind','variants']) || !Array.isArray(value.variants) || !value.variants.length || value.variants.length>256)invalidSchema('некорректные варианты');
      const seen=new Set<string>();for(const variant of value.variants){if(!object(variant) || !hasOnly(variant,['tag','type']) || typeof variant.tag!=='string' || !variant.tag || variant.tag.length>120 || seen.has(variant.tag))invalidSchema('некорректный или повторный вариант');seen.add(variant.tag);pending.push({value:variant.type,depth:item.depth+1});}continue;
    }
    invalidSchema('неизвестный вид');
  }
}

function registryFor(value:DataDefinitions):Registry {
  if(!object(value) || !hasOnly(value,['definitions','root']) || !Array.isArray(value.definitions) || value.definitions.length>256)invalidSchema('некорректный список определений');
  const names=new Set<string>();for(const entry of value.definitions){if(!object(entry) || !hasOnly(entry,['name','type']) || typeof entry.name!=='string' || !namePattern.test(entry.name) || names.has(entry.name))invalidSchema('некорректное или повторное имя');names.add(entry.name);}
  inspectType(value.root,names);for(const entry of value.definitions)inspectType(entry.type,names);
  const registry=new Map(value.definitions.map(entry=>[entry.name,entry.type]));
  // Alias/optional cycles make no progress through a value and would never
  // terminate. Lists, records and variants consume a finite child instead.
  const state=new Map<string,1|2>();
  const visit=(name:string):void=>{if(state.get(name)===1)invalidSchema('рекурсивная ссылка без перехода к вложенному значению');if(state.get(name)===2)return;state.set(name,1);let type=registry.get(name)!;while(type.kind==='optional')type=type.of;if(type.kind==='ref')visit(type.name);state.set(name,2);};
  for(const name of names)visit(name);
  // Reject types that admit only infinite objects. Lists may be empty, optional
  // values may be null, and variants need at least one finite alternative.
  const inhabited=new Set<string>();
  const finite=(type:DataType):boolean=>{if(type.kind==='ref')return inhabited.has(type.name);if(type.kind==='record')return type.fields.every(field=>field.optional || finite(field.type));if(type.kind==='variant')return type.variants.some(item=>finite(item.type));return true;};
  let changed=true;while(changed){changed=false;for(const [name,type] of registry)if(!inhabited.has(name) && finite(type)){inhabited.add(name);changed=true;}}
  if(inhabited.size!==registry.size || !finite(value.root))invalidSchema('тип не допускает конечного значения');
  return registry;
}

export function validateDataDefinitions(value:DataDefinitions):DataDefinitions {registryFor(value);return value;}

/** The order of named definitions, record fields and variants has no effect on
 * validation. Compare their structure independently of editor ordering. */
export function dataDefinitionsKey(value:DataDefinitions):string {
  const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
  const type=(entry:DataType):unknown=>{
    if(entry.kind==='ref')return {kind:entry.kind,name:entry.name};
    if(entry.kind==='literal')return {kind:entry.kind,value:entry.value};
    if(entry.kind==='optional')return {kind:entry.kind,of:type(entry.of)};
    if(entry.kind==='list')return {kind:entry.kind,item:type(entry.item)};
    if(entry.kind==='record')return {kind:entry.kind,allowExtra:!!entry.allowExtra,fields:entry.fields.map(field=>({name:field.name,optional:!!field.optional,type:type(field.type)})).sort((a,b)=>order(a.name,b.name))};
    if(entry.kind==='variant')return {kind:entry.kind,variants:entry.variants.map(variant=>({tag:variant.tag,type:type(variant.type)})).sort((a,b)=>order(a.tag,b.tag))};
    return {kind:entry.kind};
  };
  return JSON.stringify({root:type(value.root),definitions:value.definitions.map(item=>({name:item.name,type:type(item.type)})).sort((a,b)=>order(a.name,b.name))});
}

/** A resource limit produces `unknown`, never an invalid value or a proof. */
export function validateBusinessData(definitions:DataDefinitions,value:unknown,limits:DataLimits={}):DataValidation {
  const registry=registryFor(definitions),maxDepth=limits.maxDepth ?? 512,maxNodes=limits.maxNodes ?? 100_000,maxText=limits.maxTextLength ?? 1_000_000;
  if(!Number.isSafeInteger(maxDepth) || maxDepth<1 || maxDepth>4096 || !Number.isSafeInteger(maxNodes) || maxNodes<1 || maxNodes>1_000_000 || !Number.isSafeInteger(maxText) || maxText<1 || maxText>10_000_000)throw new Error('Некорректный предел проверки данных');
  type Work={kind:'check';type:DataType;value:unknown;path:string;depth:number}|{kind:'leave';value:object};
  const work:Work[]=[{kind:'check',type:definitions.root,value,path:'$',depth:0}],ancestors=new WeakSet<object>();let visited=0;
  const bad=(path:string,reason:string):DataValidation=>({status:'invalid',path,reason}),limited=(path:string,reason:string):DataValidation=>({status:'unknown',path,reason});
  while(work.length){const task=work.pop()!;if(task.kind==='leave'){ancestors.delete(task.value);continue;}let {type,value:current,path,depth}=task;
    if(++visited>maxNodes || work.length>maxNodes)return limited(path,'Исчерпан предел количества проверяемых узлов');
    if(depth>maxDepth)return limited(path,'Исчерпан предел глубины проверки');
    while(type.kind==='ref'){type=registry.get(type.name)!;if(++visited>maxNodes)return limited(path,'Исчерпан предел количества проверяемых узлов');}
    if(type.kind==='optional'){if(current!==null)work.push({kind:'check',type:type.of,value:current,path,depth});continue;}
    if(type.kind==='null'){if(current!==null)return bad(path,'Ожидалось пустое значение');continue;}
    if(type.kind==='boolean'){if(typeof current!=='boolean')return bad(path,'Ожидалось логическое значение');continue;}
    if(type.kind==='literal'){if(current!==type.value)return bad(path,'Значение не совпадает с заданным вариантом');continue;}
    if(type.kind==='text' || type.kind==='integer' || type.kind==='decimal'){
      if(typeof current!=='string')return bad(path,'Ожидалась строка');if(current.length>maxText)return limited(path,'Исчерпан предел длины проверяемого значения');
      if(type.kind==='integer' && (!integerPattern.test(current) || current==='-0'))return bad(path,'Ожидалось целое число в виде строки');
      if(type.kind==='decimal' && !decimalPattern.test(current) && !fractionPattern.test(current))return bad(path,'Ожидалось точное дробное число в виде строки');continue;
    }
    if(type.kind==='json' && (current===null || typeof current==='boolean' || typeof current==='number' && Number.isFinite(current)))continue;
    if(type.kind==='json' && typeof current==='string'){if(current.length>maxText)return limited(path,'Исчерпан предел длины проверяемого значения');continue;}
    if(type.kind==='list' || type.kind==='json' && Array.isArray(current)){
      if(!Array.isArray(current))return bad(path,'Ожидался список');if(ancestors.has(current))return bad(path,'Значение содержит цикл объектов');if(current.length>maxNodes-work.length)return limited(path,'Исчерпан предел количества проверяемых узлов');
      ancestors.add(current);work.push({kind:'leave',value:current});for(let index=current.length-1;index>=0;index--)work.push({kind:'check',type:type.kind==='list'?type.item:{kind:'json'},value:current[index],path:`${path}[${index}]`,depth:depth+1});continue;
    }
    if(type.kind==='record' || type.kind==='variant' || type.kind==='json'){
      if(!object(current))return bad(path,'Ожидалась запись');if(ancestors.has(current))return bad(path,'Значение содержит цикл объектов');
      const keys=Object.keys(current);if(keys.length>maxNodes-work.length)return limited(path,'Исчерпан предел количества проверяемых узлов');if(keys.some(key=>key.length>maxText))return limited(path,'Исчерпан предел длины имени поля');
      ancestors.add(current);work.push({kind:'leave',value:current});
      if(type.kind==='variant'){
        if(!hasOnly(current,['tag','value']) || !Object.hasOwn(current,'value') || typeof current.tag!=='string')return bad(path,'Ожидался вариант с полями tag и value');
        const variant=type.variants.find(item=>item.tag===current.tag);if(!variant)return bad(path,'Неизвестный вариант');work.push({kind:'check',type:variant.type,value:current.value,path:`${path}.value`,depth:depth+1});continue;
      }
      if(type.kind==='json'){for(const key of keys)work.push({kind:'check',type:{kind:'json'},value:current[key],path:`${path}[${JSON.stringify(key)}]`,depth:depth+1});continue;}
      if(type.kind!=='record')return bad(path,'Значение не соответствует типу');
      const fieldNames=new Set(type.fields.map(field=>field.name));if(!type.allowExtra && keys.some(key=>!fieldNames.has(key)))return bad(path,'В записи есть неизвестное поле');
      for(const field of type.fields){if(!Object.hasOwn(current,field.name)){if(!field.optional)return bad(path,`Не заполнено поле «${field.name}»`);continue;}work.push({kind:'check',type:field.type,value:current[field.name],path:`${path}[${JSON.stringify(field.name)}]`,depth:depth+1});}
      if(type.allowExtra)for(const key of keys)if(!fieldNames.has(key))work.push({kind:'check',type:{kind:'json'},value:current[key],path:`${path}[${JSON.stringify(key)}]`,depth:depth+1});continue;
    }
    return bad(path,'Значение не соответствует типу');
  }
  return {status:'valid'};
}

export type DataPath=(string|number)[];
export type DataResult={status:'ok';value:unknown}|Exclude<DataValidation,{status:'valid'}>;

function atPath(value:unknown,path:DataPath,allowMissingLast=false):DataResult {
  let current=value;
  for(let index=0;index<path.length;index++){
    const segment=path[index]!,last=index===path.length-1;
    if(Array.isArray(current)){
      if(typeof segment!=='number' || !Number.isSafeInteger(segment) || segment<0 || segment>=current.length)return {status:'invalid',path:`$[${index}]`,reason:'Элемент списка не найден'};
      current=current[segment];continue;
    }
    if(!object(current) || typeof segment!=='string')return {status:'invalid',path:`$[${index}]`,reason:'Поле записи не найдено'};
    if(!Object.hasOwn(current,segment)){if(last && allowMissingLast)return {status:'ok',value:undefined};return {status:'invalid',path:`$[${index}]`,reason:'Поле записи не найдено'};}
    current=current[segment];
  }
  return {status:'ok',value:current};
}

/** Operations are immutable. Limits stop processing without changing data. */
export function readBusinessData(definitions:DataDefinitions,value:unknown,path:DataPath,limits:DataLimits={}):DataResult {
  const valid=validateBusinessData(definitions,value,limits);if(valid.status!=='valid')return valid;
  if(!Array.isArray(path) || path.length>(limits.maxDepth ?? 512))return {status:'unknown',path:'$',reason:'Исчерпан предел глубины пути'};
  return atPath(value,path);
}
function changeBusinessData(definitions:DataDefinitions,value:unknown,path:DataPath,replacement:unknown,remove:boolean,limits:DataLimits):DataResult {
  const valid=validateBusinessData(definitions,value,limits);if(valid.status!=='valid')return valid;
  if(!Array.isArray(path) || path.length>(limits.maxDepth ?? 512))return {status:'unknown',path:'$',reason:'Исчерпан предел глубины пути'};
  if(!path.length){if(remove)return {status:'invalid',path:'$',reason:'Корень нельзя удалить'};const checked=validateBusinessData(definitions,replacement,limits);return checked.status==='valid'?{status:'ok',value:replacement}:checked;}
  const existing=atPath(value,path,!remove);if(existing.status!=='ok')return existing;
  const parents:unknown[]=[];let current=value;
  for(const segment of path){parents.push(current);current=Array.isArray(current)?current[segment as number]:(current as Record<string,unknown>)[segment as string];}
  let next=replacement;
  for(let index=path.length-1;index>=0;index--){const parent=parents[index],segment=path[index]!,last=index===path.length-1;
    if(Array.isArray(parent)){const copy=parent.slice();if(last && remove)copy.splice(segment as number,1);else copy[segment as number]=next;next=copy;}
    else {const copy={...(parent as Record<string,unknown>)};if(last && remove)delete copy[segment as string];else Object.defineProperty(copy,segment,{value:next,writable:true,enumerable:true,configurable:true});next=copy;}
  }
  const checked=validateBusinessData(definitions,next,limits);return checked.status==='valid'?{status:'ok',value:next}:checked;
}
export function replaceBusinessData(definitions:DataDefinitions,value:unknown,path:DataPath,replacement:unknown,limits:DataLimits={}):DataResult {return changeBusinessData(definitions,value,path,replacement,false,limits);}
export function removeBusinessData(definitions:DataDefinitions,value:unknown,path:DataPath,limits:DataLimits={}):DataResult {return changeBusinessData(definitions,value,path,undefined,true,limits);}
