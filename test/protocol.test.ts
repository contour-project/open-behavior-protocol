import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, encodeCbor, format, fromContour, fromModel, inspect, parse, toContour, toModel, validate, verify, verifyRefinement, type BusinessProcess, type ProjectModel } from '../src/index.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const publishing=readFileSync(new URL('../examples/publish-article.obp',import.meta.url),'utf8');
const pricing=readFileSync(new URL('../examples/consulting-fee.obp',import.meta.url),'utf8');
const model=()=>toContour(parse(publishing),'publish_article');

test('синтаксис, модель, примеры и инварианты публикации статьи согласованы',()=>{
  const result=check(publishing);assert.equal(result.ok,true);assert.deepEqual(result.diagnostics,[]);
  const document=result.document!,span=document.processes[0]!.locations['/steps/0/id']!;assert.equal(publishing.slice(span.start.offset,span.end.offset),'"pending_check"');assert.ok(span.start.line>16);
  const summary=inspect(document).processes[0]!;assert.equal(summary.steps[0]!.id,'pending_check');
  assert.equal(inspect(document).project!.environments.length,3);assert.equal(summary.bindings.length,3);
  const report=verify(document,'publish_article');assert.equal(report.complete,true);assert.equal(report.properties[0]!.status,'verified');assert.equal(report.examples[0]!.status,'passed');
});
test('модули, общие сущности и среды связываются с одной моделью без дублирования',()=>{
  const document=parse(publishing),view=inspect(document);assert.deepEqual(view.project!.modules.find(item=>item.id==='publishing')!.dependsOn,['auth','editorial']);
  assert.equal(view.project!.entities.find(item=>item.id==='author')!.moduleId,null);
  assert.deepEqual(parse(format(document)).project!.model,document.project!.model);
  const duplicate=structuredClone(document),project=duplicate.project!.model as ProjectModel;project.modules[0]!.processes.push('publish_article');assert.ok(validate(duplicate).some(item=>item.severity==='error' && /уже принадлежит/.test(item.message)));
  const unknown=structuredClone(document),invalid=unknown.project!.model as ProjectModel;invalid.implementations[0]!.environmentId='missing';assert.ok(validate(unknown).some(item=>item.severity==='error' && /Среда/.test(item.message)));
  const external=structuredClone(document),partial=external.project!.model as ProjectModel;partial.implementations.pop();assert.ok(validate(external).some(item=>item.code==='external_implementation' && item.severity==='warning'));
});
test('математические правила являются частью модели: стоимость консультации вычисляется точно',()=>{
  const report=verify(parse(pricing),'consulting_fee');assert.equal(report.complete,true);assert.equal(report.properties[0]!.status,'verified');assert.equal(report.examples[0]!.status,'passed');
});
test('рекурсивное дерево выражения подходит для описания внутренних систем',()=>{
  const source=readFileSync(new URL('../examples/expression-tree.obp',import.meta.url),'utf8'),document=parse(source);
  assert.equal(verify(document,'expression_tree').properties[0]!.status,'verified');
  assert.deepEqual(toContour(parse(format(document)),'expression_tree'),toContour(document,'expression_tree'));
});
test('ошибки и противоречивые ветви не выдаются за успешную проверку',()=>{
  const item=model();const choice=item.steps[0]!;assert.equal(choice.kind,'choice');if(choice.kind!=='choice')throw new Error();
  choice.branches[1]!.otherwise=false;choice.branches[1]!.when={op:'boolean',value:true};
  const report=verify(fromContour('publish_article',item),'publish_article');assert.ok(report.issues.some(issue=>issue.kind==='overlap'));
  const action=choice.branches[0]!.steps[0]!;assert.equal(action.kind,'action');if(action.kind!=='action')throw new Error();
  action.changes=action.changes.filter(change=>change.factId!=='pending');
  assert.equal(verify(fromContour('publish_article',item),'publish_article').properties[0]!.status,'violated');
});
test('неизвестное и незаданное не превращается в доказательство',()=>{
  const item=model();const choice=item.steps[0]!;if(choice.kind!=='choice')throw new Error();const action=choice.branches[0]!.steps[0]!;if(action.kind!=='action')throw new Error();action.specified=false;
  const report=verify(fromContour('publish_article',item),'publish_article');assert.equal(report.complete,false);assert.equal(report.properties[0]!.status,'unknown');
});
test('round-trip сохраняет ID, версии, источники, привязки и совместимость прежнего API',()=>{
  const item=model();item.basis={kind:'code',note:'По коду',sources:[{moduleId:'01234567-89ab-cdef-0123-456789abcdef',path:'backend/publish-article.ts',sha256:'a'.repeat(64)}]};
  item.bindings=[{blockId:'publish',implementationId:'abcdefab-cdef-abcd-efab-cdefabcdefab'}];
  const original=structuredClone(item),id='01234567-89ab-cdef-0123-456789abcdef';
  const text=format(fromContour(id,item));const restored=toContour(parse(text),id);
  assert.deepEqual(fromModel(id,item),fromContour(id,item));
  assert.deepEqual(toModel(parse(text),id),restored);
  assert.deepEqual(restored,original);assert.deepEqual(item,original);
  const view=inspect(parse(text));assert.deepEqual(view.processes[0]!.bindings,original.bindings);assert.deepEqual(view.processes[0]!.basis,original.basis);
});
test('структурированные и рекурсивные данные переживают перенос в текст',()=>{
  const item=model();item.facts.push({id:'tree',title:'Дерево',type:'data',dataSchema:{definitions:[{name:'tree',type:{kind:'variant',variants:[{tag:'leaf',type:{kind:'decimal'}},{tag:'branch',type:{kind:'record',fields:[{name:'child',type:{kind:'ref',name:'tree'}}]}}]}}],root:{kind:'ref',name:'tree'}},initial:{kind:'value',value:'{"tag":"leaf","value":"0.1"}'}});
  const text=format(fromContour('recursive',item));assert.deepEqual(toContour(parse(text),'recursive'),item);
});
test('сравнение формальных моделей требует явного сопоставления',()=>{
  const base=fromContour('publish_article',model()),mapping={facts:{pending:'pending',published:'published'},actions:{publish:'publish',skip:'skip'}};
  const report=verifyRefinement(base,'publish_article',base,'publish_article',mapping);assert.equal(report.status,'verified');assert.match(report.scope,/формальных моделей/);
  const other=model(),choice=other.steps[0]!;if(choice.kind!=='choice')throw new Error();const action=choice.branches[0]!.steps[0]!;if(action.kind!=='action')throw new Error();action.changes=[];
  assert.equal(verifyRefinement(base,'publish_article',fromContour('other',other),'other',mapping).status,'violated');
});
test('несколько процессов и предупреждение о неразрешённом вызове',()=>{
  const item=model();item.steps.push({id:'shared_call',kind:'call',title:'Общий блок',processId:'01234567-89ab-cdef-0123-456789abcdef',revision:1,definitionId:'shared',arguments:{}});
  const first=fromContour('publish_article',item),second=fromContour('consulting_fee',toContour(parse(pricing),'consulting_fee'));
  const document={...first,processes:[...first.processes,...second.processes]},text=format(document),result=check(text);
  assert.equal(result.ok,true);assert.equal(result.document!.processes.length,2);assert.ok(result.diagnostics.some(d=>d.code==='external_call'));
  assert.equal(check(text,{strict:true}).ok,false);assert.equal(verify(result.document!,'publish_article').complete,false);
});
test('синтаксические ошибки имеют местоположение, дубли не перезаписываются',()=>{
  const syntax=check('obp 0.1;\nprocess p { version: 1, version: 2 }');assert.equal(syntax.ok,false);assert.equal(syntax.diagnostics[0]!.code,'syntax');assert.equal(syntax.diagnostics[0]!.span!.start.line,2);
  assert.throws(()=>parse('obp 0.1; process a {} process a {}'),/дважды/);
  assert.throws(()=>parse('obp 0.2; process a {}'),/верс/);
  const safe=parse('obp 0.1; process x { "__proto__": { poisoned: true } }');assert.equal(({} as {poisoned?:boolean}).poisoned,undefined);assert.equal(Object.hasOwn(safe.processes[0]!.model as object,'__proto__'),true);
});
test('CBOR передаёт значения без зависимости от платформы',()=>{
  assert.equal(Buffer.from(encodeCbor({ok:true,count:2})).toString('hex'),'a2626f6bf565636f756e7402');
  const cycle:unknown[]=[];cycle.push(cycle);assert.throws(()=>encodeCbor(cycle),/acyclic/);
});
test('CLI отличает успешную проверку, ошибку и неизвестный результат',()=>{
  const cli=fileURLToPath(new URL('../bin/obp.ts',import.meta.url)),example=fileURLToPath(new URL('../examples/publish-article.obp',import.meta.url));
  const ok=spawnSync(process.execPath,[cli,'verify',example],{cwd:root,encoding:'utf8'});assert.equal(ok.status,0);assert.equal(JSON.parse(ok.stdout).properties[0].status,'verified');
  const invalid=spawnSync(process.execPath,[cli,'check',example,'--bad'],{cwd:root,encoding:'utf8'});assert.equal(invalid.status,2);
  const binary=spawnSync(process.execPath,[cli,'inspect',example,'--cbor'],{cwd:root});assert.equal(binary.status,0);assert.equal(binary.stdout[0],0xa3);
  const incomplete=model(),choice=incomplete.steps[0]!;if(choice.kind!=='choice')throw new Error();const action=choice.branches[0]!.steps[0]!;if(action.kind!=='action')throw new Error();action.specified=false;
  const folder=mkdtempSync(join(tmpdir(),'obp-cli-test-'));try {const path=join(folder,'incomplete.obp');writeFileSync(path,format(fromContour('publish_article',incomplete)));const result=spawnSync(process.execPath,[cli,'verify',path],{cwd:root,encoding:'utf8'});assert.equal(result.status,2);assert.equal(JSON.parse(result.stdout).complete,false);}finally{rmSync(folder,{recursive:true,force:true});}
});
