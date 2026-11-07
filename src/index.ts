import { parse, OBPError, type Document, type Span } from './parser.ts';
import { checkBusinessProcess, checkBusinessRefinement, checkBusinessTrace, validateBusinessProcess, type BusinessProcess, type Example, type ProcessReport, type RefinementMapping, type RefinementReport } from './business-process.ts';
import { processCalls } from './business-process-library.ts';
import { missingImplementations, validateProject, type ProjectModel } from './project-model.ts';

export { parse, OBPError } from './parser.ts';
export { encodeCbor } from './cbor.ts';
export type { Document, Position, ProcessDeclaration, ProjectDeclaration, Span } from './parser.ts';
export type { ProjectModel, ProjectModule, ProjectEntity, ProjectEnvironment, ProjectImplementation } from './project-model.ts';
export { validateProject } from './project-model.ts';
export type { BusinessProcess, Block, Fact, Property, Example, ProcessReport, RefinementMapping, RefinementReport } from './business-process.ts';
export type { AlgorithmValue, Expression } from './business-algorithm.ts';
export type { DataDefinitions, DataType } from './business-data.ts';
export { emptyBusinessProcess, checkBusinessProcess, checkBusinessTrace, checkBusinessRefinement, generateBusinessExamples, validateBusinessProcess } from './business-process.ts';
export { evaluateExpression, expressionContext, runAlgorithm, checkAlgorithm } from './business-algorithm.ts';
export { validateBusinessData, validateDataDefinitions } from './business-data.ts';

export type Diagnostic = {severity:'error'|'warning';code:string;message:string;processId?:string;span?:Span};
export type CheckResult = {ok:boolean;document:Document|null;diagnostics:Diagnostic[]};

/** Validate shape and types; warnings identify dependencies a host must resolve. */
export function validate(document:Document):Diagnostic[] {
  const diagnostics:Diagnostic[]=[];
  if(!document || document.protocol!=='obp' || document.version!=='0.1' || !Array.isArray(document.processes) || !document.processes.length && !document.project)return [{severity:'error',code:'document',message:'Ожидался документ OBP 0.1 с проектом или процессами.'}];
  const ids=new Set<string>(),models:BusinessProcess[]=[];
  for(const process of document.processes){
    if(!process || typeof process.id!=='string' || !process.id.trim() || process.id.length>200 || ids.has(process.id)){
      diagnostics.push({severity:'error',code:'process_id',message:'Идентификаторы процессов должны быть непустыми и уникальными.',...(process?.span?{span:process.span}:{})});continue;
    }
    ids.add(process.id);
    try {
      const model=validateBusinessProcess(process.model);models.push(model);
      for(const call of processCalls(model))diagnostics.push({severity:'warning',code:'external_call',processId:process.id,span:process.span,message:`Общий блок «${call.title}» требует разрешения версии и параметров процесса ${call.processId} со стороны хоста.`});
    } catch(error) {diagnostics.push({severity:'error',code:'model',processId:process.id,span:process.span,message:error instanceof Error?error.message:'Некорректная модель'});}
  }
  if(document.project){
    const project=document.project;
    try {
      if(typeof project.id!=='string' || !project.id.trim() || project.id.length>200)throw new Error('Некорректный идентификатор проекта.');
      const model=validateProject(project.model,ids);
      for(const id of missingImplementations(model,models))diagnostics.push({severity:'warning',code:'external_implementation',span:project.span,message:`Реализация ${id} не объявлена в документе; её должен разрешить хост.`});
    }catch(error){diagnostics.push({severity:'error',code:'project',span:project.span,message:error instanceof Error?error.message:'Некорректный проект'});}
  }else {
    const referenced=new Set<string>();for(const model of models)for(const binding of model.bindings)referenced.add(binding.implementationId);
    for(const id of referenced)diagnostics.push({severity:'warning',code:'external_implementation',message:`Реализация ${id} не объявлена в документе; её должен разрешить хост.`});
  }
  return diagnostics;
}

/** Syntactic and semantic validation only: success is not a proof. */
export function check(source:string,options:{filename?:string;strict?:boolean}={}):CheckResult {
  try {
    const document=parse(source,options),diagnostics=validate(document);
    return {ok:!diagnostics.some(item=>item.severity==='error' || options.strict && item.severity==='warning'),document,diagnostics};
  } catch(error) {
    if(error instanceof OBPError)return {ok:false,document:null,diagnostics:[{severity:'error',code:'syntax',message:error.message,span:{start:error.position,end:error.position}}]};
    throw error;
  }
}

function modelFor(document:Document,id:string):BusinessProcess {
  const errors=validate(document).filter(item=>item.severity==='error');if(errors.length)throw new Error(errors[0]!.message);
  const process=document.processes.find(item=>item.id===id);if(!process)throw new Error(`Процесс «${id}» не найден`);
  return validateBusinessProcess(process.model);
}

/** Stable, renderer-neutral descriptions; connections do not prove conformance. */
export function inspect(document:Document):{version:'0.1';project?:(ProjectModel & {id:string});processes:(BusinessProcess & {id:string})[]} {
  const error=validate(document).find(item=>item.severity==='error');if(error)throw new Error(error.message);
  const project=document.project?structuredClone({id:document.project.id,...validateProject(document.project.model,new Set(document.processes.map(item=>item.id)))}):undefined;
  return {version:'0.1',...(project?{project}:{}),processes:document.processes.map(process=>structuredClone({id:process.id,...validateBusinessProcess(process.model)}))};
}

/** Check the model under the checker's reported scope and assumptions. */
export function verify(document:Document,id:string):ProcessReport {return checkBusinessProcess(modelFor(document,id));}
export function verifyTrace(document:Document,id:string,trace:Example):ProcessReport['examples'][number] {return checkBusinessTrace(modelFor(document,id),trace);}
export function verifyRefinement(business:Document,businessId:string,implementation:Document,implementationId:string,mapping:RefinementMapping,options:{maxStates?:number;timeoutMs?:number}={}):RefinementReport {
  return checkBusinessRefinement(modelFor(business,businessId),modelFor(implementation,implementationId),mapping,options);
}

/** Convert without dropping IDs, source provenance or implementation bindings. */
export function fromModel(id:string,model:unknown):Document {
  if(!id.trim() || id.length>200)throw new Error('Укажите идентификатор процесса');
  const validated=validateBusinessProcess(model),position={offset:0,line:1,column:1};
  return {protocol:'obp',version:'0.1',processes:[{id,model:structuredClone(validated),span:{start:position,end:position},locations:{}}]};
}
export function toModel(document:Document,id:string):BusinessProcess {return structuredClone(modelFor(document,id));}

/** @deprecated Use fromModel. Retained for compatibility with existing callers. */
export const fromContour=fromModel;
/** @deprecated Use toModel. Retained for compatibility with existing callers. */
export const toContour=toModel;

/** Canonical text; comments and whitespace are not retained. */
export function format(document:Document):string {
  const diagnostics=validate(document),error=diagnostics.find(item=>item.severity==='error');if(error)throw new Error(error.message);
  const declarations=[...(document.project?[`project ${JSON.stringify(document.project.id)} ${JSON.stringify(document.project.model,null,2)}\n`]:[]),...document.processes.map(item=>`process ${JSON.stringify(item.id)} ${JSON.stringify(item.model,null,2)}\n`)];
  return `obp 0.1;\n\n${declarations.join('\n')}`;
}
