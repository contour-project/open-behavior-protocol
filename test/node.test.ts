import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, toContour, emptyBusinessProcess, type Expression } from '../src/index.ts';
import { checkImplementationExamples, proveFractionalProperties } from '../src/node/index.ts';

const source=readFileSync(new URL('../examples/publish-article.obp',import.meta.url),'utf8'),model=toContour(parse(source),'publish_article');
const adapter=fileURLToPath(new URL('./fixtures/adapter.ts',import.meta.url)),cwd=fileURLToPath(new URL('../',import.meta.url));

test('адаптер сравнивает реальные наблюдения и выявляет расхождение',async()=>{
  const good=await checkImplementationExamples(model,{command:process.execPath,args:[adapter],cwd});
  assert.equal(good.passed,1);assert.equal(good.failed,0);assert.match(good.note,/не доказаны/i);
  const wrong=await checkImplementationExamples(model,{command:process.execPath,args:[adapter,'wrong'],cwd});assert.equal(wrong.failed,1);assert.equal(wrong.passed,0);
});

test('адаптер не получает окружение хоста без явного указания',async()=>{
  const old=process.env.OBP_TEST_SECRET;process.env.OBP_TEST_SECRET='test-only';
  try {const report=await checkImplementationExamples(model,{command:process.execPath,args:[adapter,'env'],cwd});assert.equal(report.passed,1);}
  finally {if(old===undefined)delete process.env.OBP_TEST_SECRET;else process.env.OBP_TEST_SECRET=old;}
});

test('SMT доказывает дробное тождество без округления и не доказывает деление на ноль',async()=>{
  const value=emptyBusinessProcess(),decimal=(number:string):Expression=>({op:'decimal',value:number}),variable=(id:string):Expression=>({op:'var',id}),op=(name:string,...args:Expression[]):Expression=>({op:name,args});
  value.facts=[{id:'price',title:'Цена',type:'decimal',initial:{kind:'any'}}];
  value.steps=[{id:'show',kind:'action',title:'Показать',actor:'',guard:{op:'boolean',value:true},changes:[],specified:true}];
  value.properties=[{id:'sum',title:'Точная сумма',kind:'always',expr:op('eq',op('add',decimal('0.1'),decimal('0.2')),decimal('0.3'))},{id:'zero',title:'Деление на ноль',kind:'always',expr:op('eq',op('divide',variable('price'),op('sub',variable('price'),variable('price'))),decimal('0'))}];
  const results=await proveFractionalProperties(value);assert.equal(results.find(item=>item.id==='sum')?.status,'verified');assert.equal(results.find(item=>item.id==='sum')?.proofMethod,'smt');assert.equal(results.some(item=>item.id==='zero' && item.status==='verified'),false);
});
