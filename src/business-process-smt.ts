import { init, killThreads } from 'z3-solver';
import { evaluateExpression, type Expression } from './business-algorithm.ts';
import type { ActionBlock, Block, BusinessProcess, ProofEvidence, PropertyResult } from './business-process.ts';

type Node={op:string;id?:string;value?:unknown;args?:Expression[];condition?:Expression;then?:Expression;else?:Expression};
type Term={kind:'number'|'boolean';code:string;defined:string;safe:boolean;refs:Set<string>};
type Environment=Map<string,Term>;
const all=(items:string[])=>items.length===0?'true':items.length===1?items[0]!: ` (and ${items.join(' ')}) `;
const implies=(left:string,right:string)=>`(=> ${left} ${right})`;
const merge=(terms:Term[])=>new Set(terms.flatMap(term=>[...term.refs]));
const signed=(n:bigint)=>n<0n?`(- ${-n})`:String(n);
const MAX_NUMERATOR=10n**60n-1n;

function rational(value:string):string|null {
  const fraction=/^(-?(?:0|[1-9]\d{0,59}))\/([1-9]\d{0,59})$/.exec(value);
  if(fraction)return `(/ ${signed(BigInt(fraction[1]!))} ${fraction[2]})`;
  const decimal=/^(-?)(0|[1-9]\d{0,59})(?:\.(\d{1,12}))?$/.exec(value);if(!decimal)return null;
  const numerator=BigInt(`${decimal[1]}${decimal[2]}${decimal[3] || ''}`),denominator=10n**BigInt((decimal[3] || '').length);
  return denominator===1n?signed(numerator):`(/ ${signed(numerator)} ${denominator})`;
}
function isZero(node:Node|undefined):boolean {if(!node || !['integer','decimal'].includes(node.op) || typeof node.value!=='string')return false;try{return /^-?0(?:\.0+)?$/.test(node.value);}catch{return false;}}
function isOne(node:Node|undefined):boolean {return !!node && ['integer','decimal'].includes(node.op) && typeof node.value==='string' && /^1(?:\.0+)?$/.test(node.value);}
function constantMathSafe(expression:Expression):boolean {try{evaluateExpression(expression,new Map());return true;}catch{return false;}}

function compile(expression:Expression,env:Environment,depth=0):Term|null {
  if(depth>24 || !expression || typeof expression!=='object')return null;const e=expression as Node;
  if(e.op==='var' && e.id)return env.get(e.id) || null;
  if(e.op==='boolean' && typeof e.value==='boolean')return {kind:'boolean',code:String(e.value),defined:'true',safe:true,refs:new Set()};
  if(['integer','decimal'].includes(e.op) && typeof e.value==='string'){const value=rational(e.value);return value?{kind:'number',code:value,defined:'true',safe:true,refs:new Set()}:null;}
  if(e.op==='if' && e.condition && e.then && e.else){const condition=compile(e.condition,env,depth+1),left=compile(e.then,env,depth+1),right=compile(e.else,env,depth+1);if(!condition || condition.kind!=='boolean' || !left || !right || left.kind!==right.kind)return null;return {kind:left.kind,code:`(ite ${condition.code} ${left.code} ${right.code})`,defined:all([condition.defined,implies(condition.code,left.defined),implies(`(not ${condition.code})`,right.defined)]),safe:condition.safe && left.safe && right.safe,refs:merge([condition,left,right])};}
  if(!Array.isArray(e.args))return null;const parts=e.args.map(item=>compile(item,env,depth+1));if(parts.some(item=>!item))return null;const terms=parts as Term[],refs=merge(terms),a=terms[0],b=terms[1];if(!a)return null;
  if(e.op==='not' && terms.length===1 && a.kind==='boolean')return {kind:'boolean',code:`(not ${a.code})`,defined:a.defined,safe:a.safe,refs};
  if(['and','or'].includes(e.op) && terms.length>=2 && terms.every(item=>item.kind==='boolean')){const conditions:string[]=[a.defined];for(let index=1;index<terms.length;index++){const preceding=terms.slice(0,index).map(item=>e.op==='and'?item.code:`(not ${item.code})`);conditions.push(implies(all(preceding),terms[index]!.defined));}return {kind:'boolean',code:`(${e.op} ${terms.map(item=>item.code).join(' ')})`,defined:all(conditions),safe:terms.every(item=>item.safe),refs};}
  if(['eq','ne','lt','le','gt','ge'].includes(e.op) && terms.length===2 && b && a.kind===b.kind && (a.kind==='number' || ['eq','ne'].includes(e.op))){const operator=({eq:'=',ne:'=',lt:'<',le:'<=',gt:'>',ge:'>='} as Record<string,string>)[e.op]!,base=`(${operator} ${a.code} ${b.code})`;return {kind:'boolean',code:e.op==='ne'?`(not ${base})`:base,defined:all(terms.map(item=>item.defined)),safe:terms.every(item=>item.safe),refs};}
  if(!terms.every(item=>item.kind==='number'))return null;
  if(e.op==='neg' && terms.length===1)return {kind:'number',code:`(- ${a.code})`,defined:a.defined,safe:a.safe,refs};
  if(!['add','sub','mul','divide','min','max'].includes(e.op) || terms.length<2 || ['sub','divide'].includes(e.op) && terms.length!==2)return null;
  let code:string;if(e.op==='min' || e.op==='max'){code=a.code;for(const next of terms.slice(1)){if(code.length+next.code.length>20000)return null;code=`(ite (${e.op==='min'?'<=':'>='} ${code} ${next.code}) ${code} ${next.code})`;}}else code=`(${({add:'+',sub:'-',mul:'*',divide:'/'} as Record<string,string>)[e.op]} ${terms.map(item=>item.code).join(' ')})`;
  if(code.length>40000)return null;
  const defined=all([...terms.map(item=>item.defined),...(e.op==='divide'?[`(not (= ${b!.code} 0))`]:[])]);
  const nodes=e.args as Node[],simpleIdentity=e.op==='sub' && JSON.stringify(nodes[0])===JSON.stringify(nodes[1]) || e.op==='add' && terms.length===2 && (isZero(nodes[0]) || isZero(nodes[1])) || e.op==='mul' && terms.length===2 && (isOne(nodes[0]) || isOne(nodes[1])) || e.op==='divide' && isOne(nodes[1]) || ['min','max'].includes(e.op);
  const safe=terms.every(item=>item.safe) && (simpleIdentity || !refs.size && constantMathSafe(expression));
  return {kind:'number',code,defined,safe,refs};
}

function actions(model:BusinessProcess):ActionBlock[]{const result:ActionBlock[]=[];const visit=(blocks:Block[]):void=>{for(const block of blocks){if(block.kind==='action')result.push(block);else if(block.kind==='group' || block.kind==='repeat')visit(block.steps);else if(block.kind==='choice' || block.kind==='parallel')for(const branch of block.branches)visit(branch.steps);}};visit(model.steps);for(const definition of model.definitions)visit(definition.steps);return result;}
function containsDecimal(expression:Expression,model:BusinessProcess):boolean {const decimalIds=new Set(model.facts.filter(fact=>fact.type==='decimal').map(fact=>fact.id));const visit=(value:unknown):boolean=>{if(!value || typeof value!=='object')return false;if(Array.isArray(value))return value.some(visit);const node=value as Record<string,unknown>;return node.op==='decimal' || node.op==='var' && typeof node.id==='string' && decimalIds.has(node.id) || Object.values(node).some(visit);};return visit(expression);}

export async function proveFractionalProperties(model:BusinessProcess,pending:string[]):Promise<PropertyResult[]> {
  const eligible=model.properties.filter(property=>pending.includes(property.id) && property.kind==='always' && property.expr && containsDecimal(property.expr,model)).slice(0,8);if(!eligible.length)return [];
  const api=await init();try {
    const {Solver}=new api.Context('contour_fractional'),env:Environment=new Map(),declarations:string[]=[],domains:string[]=[],initial:string[]=[],usedFacts=new Map<string,{type:'integer'|'decimal'|'boolean';title:string}>();
    model.facts.forEach((fact,index)=>{if(!['integer','decimal','boolean'].includes(fact.type))return;const name=`v${index}`,kind=fact.type==='boolean'?'boolean':'number',term:Term={kind,code:name,defined:'true',safe:true,refs:new Set([fact.id])};env.set(fact.id,term);usedFacts.set(fact.id,{type:fact.type as 'integer'|'decimal'|'boolean',title:fact.title});declarations.push(`(declare-const ${name} ${kind==='boolean'?'Bool':'Real'})`);
      // The expression evaluator can form 60-digit intermediates. A larger
      // state domain is a conservative over-approximation, never a shortcut.
      if(fact.type==='integer'){const low=fact.domain?BigInt(fact.domain.min):-MAX_NUMERATOR,high=fact.domain?BigInt(fact.domain.max):MAX_NUMERATOR;domains.push(`(<= ${signed(low)} ${name})`,`(<= ${name} ${signed(high)})`);}
      if(fact.type==='decimal')domains.push(`(<= ${signed(-MAX_NUMERATOR)} ${name})`,`(<= ${name} ${signed(MAX_NUMERATOR)})`);
      if(fact.initial.kind==='value'){const raw=fact.initial.value,value=typeof raw==='boolean'?String(raw):typeof raw==='string'?rational(raw):null;if(value)initial.push(`(= ${name} ${value})`);}
    });
    const deadline=Date.now()+2200;
    const query=async(assertions:string[]):Promise<'sat'|'unsat'|'unknown'>=>{if(Date.now()>deadline)return 'unknown';try{const solver=new Solver();solver.set('timeout',200);solver.fromString(`${declarations.join('\n')}\n${assertions.map(value=>`(assert ${value})`).join('\n')}`);return await solver.check();}catch{return 'unknown';}};
    const steps=actions(model),result:PropertyResult[]=[];
    for(const property of eligible){if(Date.now()>deadline || !property.expr)break;const q=compile(property.expr,env);if(!q || q.kind!=='boolean')continue;
      if(await query([...domains,q.defined])!=='sat')continue;
      const globally=await query([...domains,q.defined,`(not ${q.code})`])==='unsat';let evidence:ProofEvidence['actions']|null=null;
      if(!globally){if(await query([...domains,...initial,q.defined])!=='sat' || await query([...domains,...initial,q.defined,`(not ${q.code})`])!=='unsat')continue;
        evidence=[];for(const action of steps){if(Date.now()>deadline){evidence=null;break;}const changes=action.changes.filter(change=>q.refs.has(change.factId));if(!changes.length){evidence.push({title:action.title,outcome:'unchanged'});continue;}
          const after=new Map(env),updateTerms:Term[]=[];let valid=true;for(const change of changes){const target=env.get(change.factId),value=compile(change.value,env);if(!target || !value || target.kind!==value.kind){valid=false;break;}after.set(change.factId,value);updateTerms.push(value);}const next=valid?compile(property.expr,after):null;if(!next || next.kind!=='boolean'){evidence=null;break;}
          const guard=action.guard?compile(action.guard,env):null,conditions=[...domains,q.defined,q.code,...updateTerms.map(item=>item.defined),next.defined,`(not ${next.code})`];if(guard?.kind==='boolean')conditions.push(guard.defined,guard.code);
          if(await query(conditions)!=='unsat'){evidence=null;break;}evidence.push({title:action.title,outcome:'preserved'});
        }if(!evidence)continue;
      }
      const variables:ProofEvidence['variables']=[];for(const id of q.refs){const fact=usedFacts.get(id);if(fact)variables.push({id,title:fact.title,type:fact.type});}
      const conditional=!q.safe,reason=conditional?'Математическое свойство следует при определённых вычислениях; деление на ноль и пределы представления дробей не доказаны. Переходы и реализация полностью не проверены.':globally?'SMT-решатель доказал свойство для всех допустимых значений. Достижимость и ошибки действий не проверены.':'SMT-решатель доказал начальное значение и сохранение свойства успешными действиями. Достижимость, завершение и ошибки действий не проверены.';
      result.push({id:property.id,title:property.title,kind:property.kind,status:conditional?'unknown':'verified',proofMethod:conditional?'smt_conditional':'smt',reason,proof:{variables,actions:evidence || []}});
    }
    return result;
  }finally{await killThreads(api.em);}
}
