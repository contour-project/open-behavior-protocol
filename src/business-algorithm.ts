import { readBusinessData, removeBusinessData, replaceBusinessData, validateBusinessData, validateDataDefinitions, type DataDefinitions, type DataPath } from './business-data.ts';

export type AlgorithmValue = string | boolean | AlgorithmRecord[];
export type AlgorithmRecord = Record<string,AlgorithmValue>;
export type Expression = {op:'hole';type:'integer'|'number'|'boolean'|'text'|'date'|'instant'|'collection'|'data';schema?:string}|{op:'var';id:string}|{op:'integer'|'decimal'|'text'|'date'|'instant';value:string}|{op:'boolean';value:boolean}|{op:'if';condition:Expression;then:Expression;else:Expression}|{op:'field';record:string;field:string}|{op:'empty_items';schema:string}|{op:'record';schema:string;fields:Record<string,Expression>}|{op:'any_item'|'all_items'|'count_items'|'filter_items'|'remove_items';collection:Expression;as:string;where:Expression}|{op:'update_items';collection:Expression;as:string;where:Expression;changes:Record<string,Expression>}|{op:'insert_item';collection:Expression;item:Expression}|{op:'data_literal';json:string}|{op:'data_get';source:Expression;path:Expression[];result:'text'|'integer'|'number'|'boolean'|'data'}|{op:'data_set';source:Expression;path:Expression[];value:Expression}|{op:'data_insert';source:Expression;path:Expression[];index:Expression;value:Expression}|{op:'data_remove'|'data_has';source:Expression;path:Expression[]}|{op:'data_length';source:Expression}|{op:string;args:Expression[];rounding?:string};
export interface AlgorithmScalarInput {id:string;title:string;type:'integer'|'decimal'|'boolean'|'choice'|'text'|'date'|'instant';unit?:string;domain?:{min:string;max:string};options?:string[]}
export interface AlgorithmCollectionInput {id:string;title:string;type:'collection';fields:AlgorithmInput[];unit?:never;domain?:never;options?:never}
export interface AlgorithmDataInput {id:string;title:string;type:'data';dataSchema:DataDefinitions;unit?:never;domain?:never;options?:never}
export type AlgorithmInput = AlgorithmScalarInput | AlgorithmCollectionInput | AlgorithmDataInput;
export interface AlgorithmStatement {id:string;title:string;expr:Expression}
export interface AlgorithmExample {title:string;inputs:Record<string,AlgorithmValue>;outputs:Record<string,AlgorithmValue>}
export interface AlgorithmSpec {version:1;inputs:AlgorithmScalarInput[];steps:AlgorithmStatement[];outputs:AlgorithmStatement[];requires:AlgorithmStatement[];ensures:AlgorithmStatement[];examples:AlgorithmExample[];basis?:{kind:'code'|'requirement';note:string}}
export interface AlgorithmReport {examples:{title:string;passed:boolean;error?:string}[];exhaustive:{status:'unproven'|'counterexample'|'error'|'vacuous'|'proved_bounded'|'checked_bounded';checked?:number;applicable?:number;assertions?:number;inputs?:Record<string,AlgorithmValue>;reason?:string;result?:AlgorithmRun}}
export interface AlgorithmRun {status:'ok'|'assertion_failed'|'precondition_failed';outputs?:Record<string,AlgorithmValue>;steps?:{id:string;value:AlgorithmValue}[];failedRequires?:{id:string;title:string}[];failedEnsures?:{id:string;title:string}[]}

// A small, total-in-structure business expression language. Expressions are
// data, never JavaScript; money can be represented in integer minor units.
const LIMIT = 4096;
const integerPattern = /^-?(?:0|[1-9][0-9]{0,29})$/;
const decimalPattern = /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,12})?$/;
const resultIntegerPattern = /^-?(?:0|[1-9][0-9]{0,59})$/;
const fractionPattern = /^(-?(?:0|[1-9][0-9]{0,59}))\/([1-9][0-9]{0,59})$/;
const idPattern = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_COLLECTION_ITEMS = 64;
const rationalTag = Symbol('rational');
const dataTag = Symbol('business-data');
type Rational={n:bigint;d:bigint;[rationalTag]:true};
type RuntimeData={value:unknown;schema:DataDefinitions;[dataTag]:true};
type Numeric=bigint|Rational;
type RuntimeValue=Numeric|RuntimeData|string|boolean|RuntimeValue[]|{[key:string]:RuntimeValue};
type ExpressionBudget={count:number;limit?:number;allowHoles?:boolean;allowQuantifiers?:boolean;allowTextOps?:boolean;allowDataOps?:boolean;collections?:Map<string,AlgorithmCollectionInput>};
// Fields are validated according to `op` before they are consumed.
type RawExpression={op:string;id:string;type:string;schema:string;record:string;field:string;value:string|boolean|Expression;json:string;source:Expression;path:Expression[];index:Expression;result:string;args:Expression[];condition:Expression;then:Expression;else:Expression;collection:Expression;item:Expression;as:string;where:Expression;fields:Record<string,Expression>;changes:Record<string,Expression>;rounding:string};
function fail(message:string):never { throw Object.assign(new Error(message), { status:400 }); }
const own = (obj:object,key:string):boolean => Object.prototype.hasOwnProperty.call(obj,key);
const plain = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
const title = (value:unknown):value is string => typeof value==='string' && value.trim().length>0 && value.length<=180;
const integer = (value:unknown):value is string => typeof value==='string' && integerPattern.test(value) && value!=='-0';
export function calendarDay(value:unknown):number {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))fail('Дата задаётся в формате ГГГГ-ММ-ДД');
  const milliseconds=Date.parse(`${value}T00:00:00.000Z`);
  if(!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0,10)!==value)fail('Несуществующая календарная дата');
  return Math.floor(milliseconds/86400000);
}
export function calendarDate(day:number):string {
  if(!Number.isSafeInteger(day))fail('Дата вне поддерживаемого диапазона');
  const value=new Date(day*86400000);if(!Number.isFinite(value.valueOf()))fail('Дата вне поддерживаемого диапазона');
  const result=value.toISOString();if(!/^\d{4}-\d{2}-\d{2}T/.test(result))fail('Дата вне поддерживаемого диапазона');return result.slice(0,10);
}
export function instantSecond(value:unknown):number {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))fail('Момент времени задаётся в UTC: ГГГГ-ММ-ДДTчч:мм:ссZ');
  const milliseconds=Date.parse(value);if(!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace('.000Z','Z')!==value)fail('Несуществующий момент времени');return milliseconds/1000;
}
export function instantValue(seconds:number):string {
  if(!Number.isSafeInteger(seconds))fail('Момент времени вне поддерживаемого диапазона');const value=new Date(seconds*1000);if(!Number.isFinite(value.valueOf()))fail('Момент времени вне поддерживаемого диапазона');const result=value.toISOString().replace('.000Z','Z');if(!/^\d{4}-\d{2}-\d{2}T/.test(result))fail('Момент времени вне поддерживаемого диапазона');return result;
}
const clamp = (value:bigint):bigint => { if(value.toString().replace('-','').length>60) fail('Превышен размер целого числа');return value; };
const absolute = (value:bigint):bigint => value<0n?-value:value;
function rational(n:bigint,d:bigint=1n):Rational {
  if(d===0n)fail('Деление на ноль');if(d<0n){n=-n;d=-d;}
  let a=absolute(n),b=d;while(b){const next=a%b;a=b;b=next;}
  const gcd=a || 1n;return {n:clamp(n/gcd),d:clamp(d/gcd),[rationalTag]:true};
}
const isRational=(value:unknown):value is Rational=>!!value && typeof value==='object' && rationalTag in value && value[rationalTag]===true;
const isData=(value:unknown):value is RuntimeData=>!!value && typeof value==='object' && dataTag in value && value[dataTag]===true;
const anyDataSchema:DataDefinitions={definitions:[],root:{kind:'json'}};
function dataValue(json:unknown,schema:DataDefinitions):RuntimeData {
  if(typeof json!=='string' || json.length>100000)fail('Укажите данные в формате JSON');let value:unknown;
  try{value=JSON.parse(json);}catch{fail('Некорректные данные JSON');}
  const result=validateBusinessData(schema,value);if(result.status!=='valid')fail(`${result.reason}: ${result.path}`);
  return {value,schema,[dataTag]:true};
}
function decimal(value:unknown):Rational {
  if(typeof value!=='string' || !decimalPattern.test(value))fail('Дробное число задаётся десятичной строкой');
  const negative=value.startsWith('-'),unsigned=negative?value.slice(1):value,[whole,fraction='']=unsigned.split('.');
  return rational(BigInt(`${negative?'-':''}${whole}${fraction}`),10n**BigInt(fraction.length));
}
function numberValue(value:unknown):Rational {const match=typeof value==='string'?fractionPattern.exec(value):null;return match?rational(BigInt(match[1]!),BigInt(match[2]!)):decimal(value);}
function dataNumber(value:string):Rational {
  const fraction=fractionPattern.exec(value);if(fraction)return rational(BigInt(fraction[1]!),BigInt(fraction[2]!));
  if(value.length>128)fail('Превышен размер числа в данных');
  const match=/^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);if(!match)fail('Ожидалось точное число в данных');
  const decimalPart=match[3] || '';return rational(BigInt(`${match[1]}${match[2]}${decimalPart}`),10n**BigInt(decimalPart.length));
}
// JSON numbers have already been parsed as IEEE-754 doubles. Interpret their
// canonical decimal rendering as a rational without inventing lost precision.
function jsonNumber(value:number):Rational {
  if(!Number.isFinite(value))fail('Некорректное JSON-число');
  const match=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));if(!match)fail('Некорректное JSON-число');
  const fraction=match[3] || '',scale=fraction.length-Number(match[4] || 0),digits=BigInt(`${match[1]}${match[2]}${fraction}`);
  return scale>=0?rational(digits,10n**BigInt(scale)):rational(digits*10n**BigInt(-scale));
}
function asRational(value:Numeric):{n:bigint;d:bigint} {return typeof value==='bigint'?{n:value,d:1n}:value;}
function compare(a:Numeric,b:Numeric):number {const x=asRational(a),y=asRational(b),left=x.n*y.d,right=y.n*x.d;return left<right?-1:left>right?1:0;}
function numericOperation(op:'add'|'sub'|'mul',a:Numeric,b:Numeric):Numeric {
  if(typeof a==='bigint' && typeof b==='bigint')return clamp(op==='add'?a+b:op==='sub'?a-b:a*b);
  const x=asRational(a),y=asRational(b);
  return op==='add'?rational(x.n*y.d+y.n*x.d,x.d*y.d):op==='sub'?rational(x.n*y.d-y.n*x.d,x.d*y.d):rational(x.n*y.n,x.d*y.d);
}
function rounded(a:bigint,b:bigint,mode:string):bigint {
  if(b===0n)fail('Деление на ноль');let q=a/b;const r=a%b;if(!r)return q;
  const sign=(a<0n)!==(b<0n)?-1n:1n;
  if(mode==='floor' && sign<0n)q-=1n;
  if(mode==='ceil' && sign>0n)q+=1n;
  if(mode==='half_away' && absolute(r)*2n>=absolute(b))q+=sign;
  if(mode==='half_positive' && (absolute(r)*2n>absolute(b) || absolute(r)*2n===absolute(b) && sign>0n))q+=sign;
  return clamp(q);
}
function numericEqual(actual:RuntimeValue|undefined,expected:AlgorithmValue|undefined):boolean {
  if(typeof expected!=='string')return false;
  if(typeof actual==='bigint' && resultIntegerPattern.test(expected))return actual===BigInt(expected);
  const numeric=typeof actual==='bigint'?rational(actual):isRational(actual)?actual:null;
  if(!numeric)return false;
  const match=fractionPattern.exec(expected),other=match?rational(BigInt(match[1]!),BigInt(match[2]!)):resultIntegerPattern.test(expected)?rational(BigInt(expected)):decimal(expected);
  return numeric.n===other.n && numeric.d===other.d;
}

// Shared expression semantics for calculations and process contracts.
// A budget can be shared across all expressions in one model.
export function typeOfExpression(value:Expression,scope:Map<string,string>,budget:ExpressionBudget={count:0},depth=0):string {
  const e=value as unknown as RawExpression;
  if(++budget.count>(budget.limit ?? 1024) || depth>24 || !plain(e) || typeof e.op!=='string')fail('Некорректное или слишком сложное выражение');
  const expression=(value:Expression):string=>typeOfExpression(value,scope,budget,depth+1);
  if(e.op==='hole' && budget.allowHoles===true && ['integer','number','boolean','text','date','instant'].includes(e.type))return e.type;
  if(e.op==='hole' && budget.allowHoles===true && budget.allowDataOps===true && e.type==='data'){if(e.schema)fail('Схема для незаполненного значения данных не указывается');return 'data:any';}
  const knownSchema=(id:string)=>typeof id==='string' && budget.collections?.has(id) && scope.get(id.split('.')[0]!)===`collection:${id.split('.')[0]}`;
  if(e.op==='hole' && budget.allowHoles===true && e.type==='collection' && knownSchema(e.schema))return `collection:${e.schema}`;
  if(['all_instances','any_instances','at_most_one_instance','count_instances'].includes(e.op) && budget.allowQuantifiers===true) {if(!Array.isArray(e.args) || e.args.length!==1 || expression(e.args[0]!)!=='boolean')fail('Укажите условие для всех запусков');return e.op==='count_instances'?'integer':'boolean';}
  if(e.op==='var') {if(typeof e.id!=='string' || !scope.has(e.id))fail(`Неизвестное значение: ${String(e.id)}`);return scope.get(e.id)!;}
  if(e.op==='integer') {if(!integer(e.value))fail('Целое число задаётся строкой');return 'integer';}
  if(e.op==='decimal') {if(typeof e.value!=='string' || !decimalPattern.test(e.value))fail('Дробное число задаётся десятичной строкой');return 'number';}
  if(e.op==='boolean') {if(typeof e.value!=='boolean')fail('Некорректное логическое значение');return 'boolean';}
  if(e.op==='text') {if(typeof e.value!=='string' || e.value.length>120)fail('Некорректный текстовый литерал');return 'text';}
  if(e.op==='date') {calendarDay(e.value);return 'date';}
  if(e.op==='instant') {instantSecond(e.value);return 'instant';}
  if(e.op==='data_literal') {if(!budget.allowDataOps || typeof e.json!=='string')fail('Данные недоступны в этой модели');dataValue(e.json,anyDataSchema);return 'data:any';}
  if(['data_get','data_set','data_insert','data_remove','data_has','data_length'].includes(e.op)) {
    if(!budget.allowDataOps)fail('Операция данных недоступна в этой модели');const source=expression(e.source);if(!source.startsWith('data:'))fail('Выберите структурированные данные');
    if(e.op!=='data_length') {if(!Array.isArray(e.path) || e.path.length>32)fail('Некорректный путь к данным');for(const part of e.path)if(!['text','integer'].includes(expression(part)))fail('Путь состоит из названий полей и номеров элементов');}
    if(e.op==='data_get'){if(!['text','integer','number','boolean','data'].includes(e.result))fail('Укажите тип получаемого значения');return e.result==='data'?'data:any':e.result;}
    if(e.op==='data_set' || e.op==='data_insert'){if(e.op==='data_insert' && expression(e.index)!=='integer')fail('Номер элемента должен быть целым числом');const type=expression(e.value as Expression);if(!['boolean','text','integer','number','date','instant'].includes(type) && !type.startsWith('data:'))fail('Недопустимое новое значение');return source;}
    return e.op==='data_has'?'boolean':e.op==='data_length'?'integer':source;
  }
  const schemaFor=(type:string)=>typeof type==='string' && type.startsWith('collection:')?budget.collections?.get(type.slice(11)):undefined;
  const fieldType=(field:AlgorithmInput,schema:AlgorithmCollectionInput)=>field.type==='collection'?`collection:${schema.id}.${field.id}`:field.type==='decimal'?'number':field.type==='choice'?'text':field.type;
  const compatible=(actual:string,expected:string)=>actual===expected || expected==='number' && actual==='integer';
  if(e.op==='field') {
    const type=scope.get(e.record),schema=typeof type==='string' && type.startsWith('record:')?budget.collections?.get(type.slice(7)):undefined,field=schema?.fields.find(item=>item.id===e.field);
    if(!field || !schema)fail('Неизвестное поле элемента коллекции');return fieldType(field,schema);
  }
  if(e.op==='empty_items'){if(!knownSchema(e.schema))fail('Неизвестный тип списка');return `collection:${e.schema}`;}
  if(e.op==='record') {
    const schema=budget.collections?.get(e.schema);if(!schema || !knownSchema(e.schema) || !plain(e.fields))fail('Неизвестный тип записи');
    if(Object.keys(e.fields).length!==schema.fields.length || schema.fields.some(field=>!own(e.fields,field.id)))fail('Укажите все поля записи');
    for(const field of schema.fields)if(!compatible(expression(e.fields[field.id]!),fieldType(field,schema)))fail(`Тип поля «${field.title}» не совпадает`);
    return `record:${e.schema}`;
  }
  if(e.op==='insert_item') {
    const type=expression(e.collection),schema=schemaFor(type);if(!schema || expression(e.item)!==`record:${schema.id}`)fail('Тип добавляемой записи не совпадает с коллекцией');return type;
  }
  if(['any_item','all_items','count_items','filter_items','remove_items','update_items'].includes(e.op)) {
    const type=expression(e.collection),schema=schemaFor(type);if(!schema || typeof e.as!=='string' || !idPattern.test(e.as) || scope.has(e.as))fail('Укажите коллекцию и имя её элемента');
    const nested=new Map(scope);nested.set(e.as,`record:${schema.id}`);
    const inside=(value:Expression):string=>typeOfExpression(value,nested,budget,depth+1);
    if(inside(e.where)!=='boolean')fail('Условие для элемента должно быть логическим');
    if(e.op==='update_items') {if(!plain(e.changes) || !Object.keys(e.changes).length || Object.keys(e.changes).length>schema.fields.length)fail('Укажите изменяемые поля записи');for(const [id,value] of Object.entries(e.changes)){const field=schema.fields.find(item=>item.id===id);if(!field || !compatible(inside(value),fieldType(field,schema)))fail('Тип изменяемого поля не совпадает');}}
    return e.op==='any_item' || e.op==='all_items'?'boolean':e.op==='count_items'?'integer':type;
  }
  if(e.op==='if') {if(expression(e.condition)!=='boolean')fail('Условие должно быть логическим');const a=expression(e.then),b=expression(e.else);if(a!==b && ![a,b].every(type=>type==='integer' || type==='number') && ![a,b].every(type=>type.startsWith('data:')))fail('Результаты ветвей должны иметь один тип');return a===b?a:a.startsWith('data:')?'data:any':'number';}
  if(!Array.isArray(e.args))fail('У операции отсутствуют аргументы');
  if(['text_length','text_concat','text_contains','text_starts_with','text_ends_with','text_slice'].includes(e.op)) {
    if(budget.allowTextOps!==true)fail('Текстовая операция недоступна в этой модели');
    const types=e.args.map(expression),valid=e.op==='text_length'?types.length===1 && types[0]==='text':e.op==='text_concat'?types.length>=2 && types.length<=16 && types.every(type=>type==='text'):e.op==='text_slice'?types.length===3 && types[0]==='text' && types[1]==='integer' && types[2]==='integer':types.length===2 && types.every(type=>type==='text');
    if(!valid)fail('Типы или число аргументов текстовой операции не совпадают');
    return e.op==='text_length'?'integer':e.op==='text_concat' || e.op==='text_slice'?'text':'boolean';
  }
  if(['add_days','days_between'].includes(e.op)) {if(e.args.length!==2)fail('Укажите дату и период');const first=expression(e.args[0]!),second=expression(e.args[1]!);if(first!=='date' || second!==(e.op==='add_days'?'integer':'date'))fail('Типы даты и периода не совпадают');return e.op==='add_days'?'date':'integer';}
  if(['add_seconds','seconds_between'].includes(e.op)) {if(e.args.length!==2)fail('Укажите время и длительность');const first=expression(e.args[0]!),second=expression(e.args[1]!);if(first!=='instant' || second!==(e.op==='add_seconds'?'integer':'instant'))fail('Типы времени и длительности не совпадают');return e.op==='add_seconds'?'instant':'integer';}
  const unary=['not','neg','round'],binary=['sub','div','divide','mod','eq','ne','lt','le','gt','ge'],variadic=['add','mul','min','max','and','or'];
  if(unary.includes(e.op) && e.args.length!==1 || binary.includes(e.op) && e.args.length!==2 || variadic.includes(e.op) && (e.args.length<2 || e.args.length>16) || ![...unary,...binary,...variadic].includes(e.op))fail('Неизвестная операция или неверное число аргументов');
  if(['div','round'].includes(e.op) && !['trunc','floor','ceil','half_away','half_positive'].includes(e.rounding) && !(budget.allowHoles===true && e.rounding==='unknown'))fail('Укажите способ округления');
  const types=e.args.map(expression),numeric=(type:string)=>type==='integer' || type==='number';
  if(['eq','ne'].includes(e.op)) {if(types[0]!==types[1] && !types.every(numeric) && !types.every(type=>type.startsWith('data:')))fail('Сравнивать можно совместимые значения');return 'boolean';}
  if(['not','and','or'].includes(e.op)) {if(types.some(type=>type!=='boolean'))fail('Тип аргументов не подходит операции');return 'boolean';}
  if(['lt','le','gt','ge'].includes(e.op) && ['date','instant'].includes(types[0]!) && types.every(type=>type===types[0]))return 'boolean';
  if(types.some(type=>!numeric(type)) || ['div','mod'].includes(e.op) && types.some(type=>type!=='integer'))fail('Тип аргументов не подходит операции');
  if(['lt','le','gt','ge'].includes(e.op))return 'boolean';
  if(['div','mod','round'].includes(e.op))return 'integer';
  return e.op==='divide' || types.includes('number')?'number':'integer';
}

export function validateAlgorithm(spec:AlgorithmSpec):AlgorithmSpec {
  if(!plain(spec) || spec.version!==1 || JSON.stringify(spec).length>60000) fail('Некорректная версия или размер алгоритма');
  if(spec.basis!=null && (!plain(spec.basis) || !['code','requirement'].includes(spec.basis.kind) || typeof spec.basis.note!=='string' || spec.basis.note.length>500))fail('Некорректное происхождение алгоритма');
  for(const [name,max] of [['inputs',12],['steps',32],['outputs',12],['requires',16],['ensures',16],['examples',16]] as const) {
    if(!Array.isArray(spec[name]) || spec[name].length>max) fail(`Некорректный список: ${name}`);
  }
  if(!spec.outputs.length) fail('Укажите хотя бы один результат алгоритма');
  const symbols=new Map<string,string>(),budget:ExpressionBudget={count:0};
  const add=(item:{id:string;title:string},type:string) => {
    if(!plain(item) || !idPattern.test(item.id || '') || !title(item.title) || symbols.has(item.id))fail('У каждого значения должен быть уникальный id и заголовок');
    symbols.set(item.id,type);
  };
  for(const input of spec.inputs) {
    if(!['integer','decimal','boolean','choice','text','date','instant'].includes(input?.type) || typeof (input.unit ?? '')!=='string' || (input.unit || '').length>40)fail('Некорректный тип входного значения');
    if(!['integer','date','instant'].includes(input.type) && input.domain!=null)fail('Диапазон поддерживается для целых значений, дат и времени');
    if(input.type==='integer' && input.domain!=null && (!plain(input.domain) || !integer(input.domain.min) || !integer(input.domain.max) || BigInt(input.domain.min)>BigInt(input.domain.max)))fail('Некорректный диапазон целого значения');
    if(input.type==='date' && input.domain!=null && (!plain(input.domain) || calendarDay(input.domain.min)>calendarDay(input.domain.max)))fail('Некорректный диапазон дат');
    if(input.type==='instant' && input.domain!=null && (!plain(input.domain) || instantSecond(input.domain.min)>instantSecond(input.domain.max)))fail('Некорректный диапазон времени');
    if(input.type==='choice' && (!Array.isArray(input.options) || !input.options.length || input.options.length>32 || input.options.some(v=>typeof v!=='string' || !v.length || v.length>120) || new Set(input.options).size!==input.options.length))fail('Некорректные варианты значения');
    add(input,input.type==='choice'?'text':input.type==='decimal'?'number':input.type);
  }
  const expression = (e:Expression,scope:Map<string,string>) => typeOfExpression(e,scope,budget);
  const assertions=(items:AlgorithmStatement[],scope:Map<string,string>) => {const ids=new Set<string>();for(const item of items) {if(!plain(item) || !idPattern.test(item.id || '') || !title(item.title) || ids.has(item.id) || expression(item.expr,scope)!=='boolean')fail('Некорректное утверждение');ids.add(item.id);}};
  assertions(spec.requires,symbols);
  for(const step of spec.steps) {const type=expression(step.expr,symbols);add(step,type);}
  const outputTypes=new Map<string,string>();
  for(const output of spec.outputs) {const type=expression(output.expr,symbols);add(output,type);outputTypes.set(output.id,type);}
  assertions(spec.ensures,symbols);
  for(const example of spec.examples) {
    if(!plain(example) || !title(example.title) || !plain(example.inputs) || !plain(example.outputs))fail('Некорректный пример');
    checkInputs(spec.inputs,example.inputs);
    if(Object.keys(example.outputs).length!==outputTypes.size || [...outputTypes].some(([id,type])=>!own(example.outputs,id) || !valueHasType(example.outputs[id],type)))fail('В примере укажите ожидаемые значения всех результатов');
  }
  return spec;
}

// Collection fields use the same scalar validation as ordinary values. A
// collection is deliberately a list of records, not an implicit database.
export function validateCollectionInput(input:AlgorithmCollectionInput,depth=0):AlgorithmCollectionInput {
  if(depth>3)fail('Списки можно вкладывать не глубже четырёх уровней');
  if(!plain(input) || !idPattern.test(input.id || '') || !title(input.title) || input.type!=='collection' || !Array.isArray(input.fields) || !input.fields.length || input.fields.length>64)fail('Укажите от 1 до 64 полей коллекции');
  if(Object.keys(input).some(key=>!['id','title','type','fields','initial','scope'].includes(key)))fail('Неизвестное поле коллекции');
  const seen=new Set<string>();for(const field of input.fields) {
    if(!plain(field) || Object.keys(field).some(key=>!(field.type==='collection'?['id','title','type','fields']:['id','title','type','unit','domain','options']).includes(key)) || seen.has(field.id))fail('Некорректное поле коллекции');seen.add(field.id);
    if(field.type==='collection'){validateCollectionInput(field,depth+1);continue;}
    if(field.type==='data')fail('Рекурсивные данные задаются отдельным значением процесса');
    let result='contour_result';while(result===field.id)result=`v${result}`;
    const candidate=field.type==='choice' && (!field.options || Array.isArray(field.options) && !field.options.length)?{...field,options:['contour-unset']}:field;
    validateAlgorithm({version:1,inputs:[candidate],steps:[],outputs:[{id:result,title:'Результат',expr:{op:'boolean',value:true}}],requires:[],ensures:[],examples:[]});
  }
  return input;
}

function valueHasType(value:unknown,type:string):boolean { if(type==='date' || type==='instant'){try{type==='date'?calendarDay(value):instantSecond(value);return true;}catch{return false;}}return type==='integer'?typeof value==='string' && resultIntegerPattern.test(value):type==='number'?typeof value==='string' && (decimalPattern.test(value) || fractionPattern.test(value) || resultIntegerPattern.test(value)):type==='boolean'?typeof value==='boolean':typeof value==='string' && value.length<=120; }
function checkInputs(inputs:AlgorithmInput[],values:Record<string,AlgorithmValue>,maxCollection=MAX_COLLECTION_ITEMS,budget={records:0},depth=0):Map<string,RuntimeValue> {
  if(depth>4)fail('Слишком глубокие данные коллекции');
  if(!plain(values) || Object.keys(values).length!==inputs.length)fail('Укажите все входные значения');
  const context=new Map<string,RuntimeValue>();
  for(const input of inputs) {
    if(input.type==='collection') {
      const records=values[input.id];if(!own(values,input.id) || !Array.isArray(records))fail(`Некорректная коллекция: ${input.title}`);if(records.length>maxCollection)fail(`Превышен предел коллекции: ${maxCollection} элементов`);
      budget.records+=records.length;if(budget.records>(maxCollection===MAX_COLLECTION_ITEMS?512:10000))fail('Превышен общий предел записей коллекций');
      const items=records.map(record=>{const fields=checkInputs(input.fields,record,maxCollection,budget,depth+1);return Object.fromEntries(input.fields.map(field=>[field.id,fields.get(field.id)!]));});
      context.set(input.id,items);continue;
    }
    if(input.type==='data'){if(!own(values,input.id))fail(`Некорректные данные: ${input.title}`);validateDataDefinitions(input.dataSchema);context.set(input.id,dataValue(values[input.id],input.dataSchema));continue;}
    const value=values[input.id];if(!own(values,input.id) || !valueHasType(value,input.type==='choice'?'text':input.type==='decimal'?'number':input.type) || input.type==='integer' && !integer(value))fail(`Некорректное значение: ${input.title}`);
    if(input.type==='choice' && (!Array.isArray(input.options) || typeof value!=='string' || !input.options.includes(value)))fail(`Неизвестный вариант: ${input.title}`);
    if(input.type==='integer' && input.domain && (BigInt(value as string)<BigInt(input.domain.min) || BigInt(value as string)>BigInt(input.domain.max)))fail(`Значение вне диапазона: ${input.title}`);
    if(input.type==='date' && input.domain && (calendarDay(value)<calendarDay(input.domain.min) || calendarDay(value)>calendarDay(input.domain.max)))fail(`Значение вне диапазона: ${input.title}`);
    if(input.type==='instant' && input.domain && (instantSecond(value)<instantSecond(input.domain.min) || instantSecond(value)>instantSecond(input.domain.max)))fail(`Значение вне диапазона: ${input.title}`);
    context.set(input.id,input.type==='integer'?BigInt(value as string):input.type==='decimal'?numberValue(value):value as string|boolean);
  }
  return context;
}
function equals(a:RuntimeValue,b:RuntimeValue):boolean {
  if(isData(a) || isData(b))return isData(a) && isData(b) && equalJson(a.value,b.value);
  if(typeof a==='bigint' || isRational(a))return (typeof b==='bigint' || isRational(b)) && compare(a,b)===0;
  if(Array.isArray(a))return Array.isArray(b) && a.length===b.length && a.every((item,index)=>equals(item,b[index]!));
  if(plain(a))return plain(b) && !isRational(b) && Object.keys(a).length===Object.keys(b).length && Object.keys(a).every(key=>own(b,key) && equals(a[key] as RuntimeValue,b[key] as RuntimeValue));
  return a===b;
}
function equalJson(a:unknown,b:unknown):boolean {
  const pending:[unknown,unknown][]=[[a,b]];let visited=0;
  while(pending.length){if(++visited>100000)fail('Превышен предел сравнения данных');const [left,right]=pending.pop()!;
    if(Array.isArray(left)){if(!Array.isArray(right) || left.length!==right.length)return false;for(let i=0;i<left.length;i++)pending.push([left[i],right[i]]);continue;}
    if(plain(left)){if(!plain(right) || Object.keys(left).length!==Object.keys(right).length)return false;for(const key of Object.keys(left)){if(!own(right,key))return false;pending.push([left[key],right[key]]);}continue;}
    if(left!==right)return false;
  }return true;
}
function numberOperand(value:RuntimeValue):Numeric {if(typeof value==='bigint' || isRational(value))return value;return fail('Ожидалось число');}
function integerOperand(value:RuntimeValue):bigint {if(typeof value==='bigint')return value;return fail('Ожидалось целое число');}
function textOperand(value:RuntimeValue):string {if(typeof value==='string')return value;return fail('Ожидался текст');}
function booleanOperand(value:RuntimeValue):boolean {if(typeof value==='boolean')return value;return fail('Ожидалось логическое значение');}
function evaluate(value:Expression,ctx:Map<string,RuntimeValue>):RuntimeValue {
  const e=value as unknown as RawExpression;
  if(e.op==='var'){const value=ctx.get(e.id);if(value===undefined)fail('Значение недоступно');return value;}
  if(e.op==='integer')return BigInt(e.value as string);
  if(e.op==='decimal')return decimal(e.value);
  if(e.op==='boolean' || e.op==='text' || e.op==='date' || e.op==='instant')return e.value as string|boolean;
  if(e.op==='data_literal')return dataValue(e.json,anyDataSchema);
  if(['data_get','data_set','data_insert','data_remove','data_has','data_length'].includes(e.op)) {
    const source=evaluate(e.source,ctx);if(!isData(source))fail('Ожидались структурированные данные');
    if(e.op==='data_length'){const raw=source.value;if(Array.isArray(raw) || typeof raw==='string')return BigInt(typeof raw==='string'?Array.from(raw).length:raw.length);if(plain(raw))return BigInt(Object.keys(raw).length);return fail('Длина доступна для списка, записи или текста');}
    const path:DataPath=e.path.map(part=>{const entry=evaluate(part,ctx);if(typeof entry==='string')return entry;if(typeof entry==='bigint' && entry>=0n && entry<=BigInt(Number.MAX_SAFE_INTEGER))return Number(entry);return fail('Некорректный элемент пути');});
    if(e.op==='data_set' || e.op==='data_insert' || e.op==='data_remove'){
      const replacement=e.op!=='data_remove'?evaluate(e.value as Expression,ctx):undefined,raw=isData(replacement)?replacement.value:typeof replacement==='bigint'?replacement.toString():isRational(replacement)?replacement.d===1n?replacement.n.toString():`${replacement.n}/${replacement.d}`:replacement;
      let result;
      if(e.op==='data_insert'){
        const list=readBusinessData(source.schema,source.value,path),index=evaluate(e.index,ctx);if(list.status!=='ok')fail(`${list.reason}: ${list.path}`);if(!Array.isArray(list.value))fail('По указанному пути нет списка');
        if(typeof index!=='bigint' || index<0n || index>BigInt(list.value.length))fail('Номер элемента вне списка');
        const next=[...list.value];next.splice(Number(index),0,raw);result=replaceBusinessData(source.schema,source.value,path,next);
      }else result=e.op==='data_set'?replaceBusinessData(source.schema,source.value,path,raw):removeBusinessData(source.schema,source.value,path);
      if(result.status!=='ok')fail(`${result.reason}: ${result.path}`);return {value:result.value,schema:source.schema,[dataTag]:true};
    }
    const result=readBusinessData(source.schema,source.value,path);if(e.op==='data_has' && result.status==='invalid')return false;if(result.status!=='ok')fail(`${result.reason}: ${result.path}`);if(e.op==='data_has')return true;
    const raw=result.value;if(e.result==='data')return {value:raw,schema:anyDataSchema,[dataTag]:true};if(e.result==='text' && typeof raw==='string')return raw;if(e.result==='boolean' && typeof raw==='boolean')return raw;
    if(e.result==='integer' && typeof raw==='string' && resultIntegerPattern.test(raw) && raw!=='-0')return clamp(BigInt(raw));
    if(e.result==='integer' && typeof raw==='number' && Number.isSafeInteger(raw))return BigInt(raw);
    if(e.result==='number' && typeof raw==='string')return dataNumber(raw);
    if(e.result==='number' && typeof raw==='number')return jsonNumber(raw);
    return fail('Тип полученного значения не совпадает');
  }
  if(e.op==='empty_items')return [];
  if(e.op==='field'){const record=ctx.get(e.record);if(!plain(record) || isRational(record) || isData(record) || !own(record,e.field))fail('Поле элемента недоступно');return record[e.field] as RuntimeValue;}
  if(e.op==='record')return Object.fromEntries(Object.entries(e.fields).map(([key,item])=>[key,evaluate(item,ctx)]));
  if(e.op==='insert_item') {const list=evaluate(e.collection,ctx),item=evaluate(e.item,ctx);if(!Array.isArray(list) || list.length>=MAX_COLLECTION_ITEMS)fail(`Превышен предел коллекции: ${MAX_COLLECTION_ITEMS} элементов`);return [...list,item];}
  if(['any_item','all_items','count_items','filter_items','remove_items','update_items'].includes(e.op)) {
    const list=evaluate(e.collection,ctx);if(!Array.isArray(list))fail('Значение не является коллекцией');
    const matched=(item:RuntimeValue)=>{const nested=new Map(ctx);nested.set(e.as,item);return evaluate(e.where,nested)===true;};
    if(e.op==='any_item')return list.some(matched);if(e.op==='all_items')return list.every(matched);if(e.op==='count_items')return BigInt(list.filter(matched).length);
    if(e.op==='filter_items')return list.filter(matched);if(e.op==='remove_items')return list.filter(item=>!matched(item));
    return list.map(item=>{if(!matched(item))return item;if(!plain(item) || isRational(item))fail('Ожидалась запись');const nested=new Map(ctx);nested.set(e.as,item as RuntimeValue);return {...item,...Object.fromEntries(Object.entries(e.changes).map(([key,change])=>[key,evaluate(change,nested)]))} as RuntimeValue;});
  }
  if(e.op==='if')return booleanOperand(evaluate(e.condition,ctx))?evaluate(e.then,ctx):evaluate(e.else,ctx);
  if(e.op==='and')return e.args.every(arg=>booleanOperand(evaluate(arg,ctx)));
  if(e.op==='or')return e.args.some(arg=>booleanOperand(evaluate(arg,ctx)));
  const args=e.args.map(arg=>evaluate(arg,ctx)),a=args[0]!,b=args[1]!;
  switch(e.op) {
    case 'text_length':return BigInt(Array.from(textOperand(a)).length);
    case 'text_concat':{const result=args.map(textOperand).join('');if(result.length>120)fail('Превышен предел длины текста');return result;}
    case 'text_contains':case 'text_starts_with':case 'text_ends_with':{const source=Array.from(textOperand(a)),part=Array.from(textOperand(b)),match=(offset:number)=>offset>=0 && offset+part.length<=source.length && part.every((value,index)=>value===source[offset+index]);if(e.op==='text_starts_with')return match(0);if(e.op==='text_ends_with')return match(source.length-part.length);for(let i=0;i<=source.length-part.length;i++)if(match(i))return true;return false;}
    case 'text_slice':{const start=integerOperand(b),end=integerOperand(args[2]!);if(start<0n || end<start)fail('Некорректные границы фрагмента текста');const chars=Array.from(textOperand(a)),size=BigInt(chars.length),from=Number(start>size?size:start),to=Number(end>size?size:end);return chars.slice(from,to).join('');}
    case 'not':return !booleanOperand(a);case 'neg':{const v=numberOperand(a);return typeof v==='bigint'?clamp(-v):rational(-v.n,v.d);}
    case 'add':return args.map(numberOperand).reduce((x,y)=>numericOperation('add',x,y));case 'sub':return numericOperation('sub',numberOperand(a),numberOperand(b));case 'mul':return args.map(numberOperand).reduce((x,y)=>numericOperation('mul',x,y));
    case 'min':return args.map(numberOperand).reduce((x,y)=>compare(x,y)<0?x:y);case 'max':return args.map(numberOperand).reduce((x,y)=>compare(x,y)>0?x:y);
    case 'div':return rounded(integerOperand(a),integerOperand(b),e.rounding);
    case 'divide':{const x=asRational(numberOperand(a)),y=asRational(numberOperand(b));return rational(x.n*y.d,x.d*y.n);}
    case 'round':{const x=asRational(numberOperand(a));return rounded(x.n,x.d,e.rounding);}
    case 'mod':{const divisor=integerOperand(b);if(divisor===0n)fail('Остаток от деления на ноль');return integerOperand(a)%divisor;}
    case 'add_days':{const days=integerOperand(b);if(days>4000000n || days< -4000000n)fail('Дата вне поддерживаемого диапазона');return calendarDate(calendarDay(a)+Number(days));}
    case 'days_between':return BigInt(calendarDay(b)-calendarDay(a));
    case 'add_seconds':{const seconds=integerOperand(b);if(seconds>400000000000n || seconds< -400000000000n)fail('Момент времени вне поддерживаемого диапазона');return instantValue(instantSecond(a)+Number(seconds));}
    case 'seconds_between':return BigInt(instantSecond(b)-instantSecond(a));
    case 'eq':return equals(a,b);case 'ne':return !equals(a,b);
    case 'lt':case 'le':case 'gt':case 'ge':{const c=typeof a==='string' && typeof b==='string'?(a<b?-1:a>b?1:0):compare(numberOperand(a),numberOperand(b));return e.op==='lt'?c<0:e.op==='le'?c<=0:e.op==='gt'?c>0:c>=0;}
    default:return fail('Неизвестная операция');
  }
}
function external(value:RuntimeValue):AlgorithmValue|AlgorithmRecord {return typeof value==='bigint'?value.toString():isRational(value)?value.d===1n?value.n.toString():`${value.n}/${value.d}`:isData(value)?JSON.stringify(value.value):Array.isArray(value)?value.map(item=>external(item) as AlgorithmRecord):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,external(value[key] as RuntimeValue)])) as AlgorithmRecord:value;}

export function expressionContext(inputs:AlgorithmInput[],values:Record<string,AlgorithmValue>):Map<string,unknown> { return checkInputs(inputs,values); }
export function validateExpressionValues(inputs:AlgorithmInput[],values:Record<string,AlgorithmValue>):void { checkInputs(inputs,values,10000); }
export function evaluateExpression(expression:Expression,context:Map<string,unknown>):AlgorithmValue { return external(evaluate(expression,context as Map<string,RuntimeValue>)) as AlgorithmValue; }

export function runAlgorithm(spec:AlgorithmSpec,inputs:Record<string,AlgorithmValue>):AlgorithmRun {
  validateAlgorithm(spec);return runValidated(spec,inputs);
}
type InternalRun=AlgorithmRun & {rawOutputs?:Map<string,RuntimeValue>};
function runValidated(spec:AlgorithmSpec,inputs:Record<string,AlgorithmValue>,captureRaw=false):InternalRun {
  const ctx=checkInputs(spec.inputs,inputs),failedRequires=spec.requires.filter(item=>!evaluate(item.expr,ctx)).map(({id,title})=>({id,title}));
  if(failedRequires.length)return {status:'precondition_failed',failedRequires};
  const steps:{id:string;value:AlgorithmValue}[]=[];for(const step of spec.steps){const value=evaluate(step.expr,ctx);ctx.set(step.id,value);steps.push({id:step.id,value:external(value) as AlgorithmValue});}
  const outputs:Record<string,AlgorithmValue>=Object.create(null),rawOutputs=new Map<string,RuntimeValue>();for(const output of spec.outputs){const value=evaluate(output.expr,ctx);ctx.set(output.id,value);outputs[output.id]=external(value) as AlgorithmValue;rawOutputs.set(output.id,value);}
  const failedEnsures=spec.ensures.filter(item=>!evaluate(item.expr,ctx)).map(({id,title})=>({id,title}));
  return {status:failedEnsures.length?'assertion_failed':'ok',steps,outputs,failedEnsures,...(captureRaw?{rawOutputs}:{})};
}

export function checkAlgorithm(spec:AlgorithmSpec):AlgorithmReport {
  validateAlgorithm(spec);
  const examples=spec.examples.map(example=>{
    try {const {rawOutputs,...result}=runValidated(spec,example.inputs,true),passed=result.status==='ok' && Object.keys(example.outputs).every(key=>{const actual=rawOutputs?.get(key),expected=example.outputs[key];return typeof actual==='bigint' || actual && typeof actual==='object' ? numericEqual(actual,expected) : actual===expected;});return {title:example.title,passed,result};}
    catch(error){return {title:example.title,passed:false,error:error instanceof Error?error.message:'Ошибка вычисления'};}
  });
  let size=1;const domains:AlgorithmValue[][]=[];
  for(const input of spec.inputs) {
    if(input.type==='boolean')domains.push([false,true]);
    else if(input.type==='choice')domains.push(input.options!);
    else if(input.type==='decimal' || input.type==='text')return {examples,exhaustive:{status:'unproven',reason:`Вход «${input.title}» не имеет конечной области для перебора`}};
    else if(input.type==='date') {if(!input.domain)return {examples,exhaustive:{status:'unproven',reason:`Не задан диапазон: ${input.title}`}};const first=calendarDay(input.domain.min),count=calendarDay(input.domain.max)-first+1;if(count>LIMIT)return {examples,exhaustive:{status:'unproven',reason:'Диапазон превышает предел перебора'}};domains.push(Array.from({length:count},(_,i)=>calendarDate(first+i)));}
    else if(input.type==='instant') {if(!input.domain)return {examples,exhaustive:{status:'unproven',reason:`Не задан диапазон: ${input.title}`}};const first=instantSecond(input.domain.min),count=instantSecond(input.domain.max)-first+1;if(count>LIMIT)return {examples,exhaustive:{status:'unproven',reason:'Диапазон превышает предел перебора'}};domains.push(Array.from({length:count},(_,i)=>instantValue(first+i)));}
    else {
      if(!input.domain)return {examples,exhaustive:{status:'unproven',reason:`Не задан диапазон: ${input.title}`}};
      const first=BigInt(input.domain.min),count=BigInt(input.domain.max)-first+1n;if(count>BigInt(LIMIT))return {examples,exhaustive:{status:'unproven',reason:'Диапазон превышает предел перебора'}};
      domains.push(Array.from({length:Number(count)},(_,i)=>(first+BigInt(i)).toString()));
    }
    size*=domains[domains.length-1]!.length;if(size>LIMIT)return {examples,exhaustive:{status:'unproven',reason:`Более ${LIMIT} сочетаний`}};
  }
  let applicable=0;
  for(let index=0;index<size;index++) {
    let rest=index;const values:Record<string,AlgorithmValue>=Object.create(null);for(let i=0;i<spec.inputs.length;i++){const domain=domains[i]!;values[spec.inputs[i]!.id]=domain[rest%domain.length]!;rest=Math.floor(rest/domain.length);}
    try {const result=runValidated(spec,values);if(result.status==='precondition_failed')continue;applicable++;if(result.status==='assertion_failed')return {examples,exhaustive:{status:'counterexample',checked:index+1,applicable,inputs:values,result}};}
    catch(error){return {examples,exhaustive:{status:'error',checked:index+1,inputs:values,reason:error instanceof Error?error.message:'Ошибка вычисления'}};}
  }
  if(!applicable)return {examples,exhaustive:{status:'vacuous',checked:size,reason:'Ни одно сочетание не удовлетворяет условиям'}};
  return {examples,exhaustive:{status:spec.ensures.length?'proved_bounded':'checked_bounded',checked:size,applicable,assertions:spec.ensures.length}};
}
