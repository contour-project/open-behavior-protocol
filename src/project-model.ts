import { validateDataDefinitions, type DataDefinitions } from './business-data.ts';
import type { BusinessProcess } from './business-process.ts';

export type ProjectModule={id:string;title:string;description?:string;processes:string[];dependsOn:string[]};
export type ProjectEntity={id:string;title:string;moduleId:string|null;description?:string;dataSchema?:DataDefinitions};
export type ProjectEnvironment={id:string;title:string;kind:string;description?:string;technologies:string[];architecture:string[]};
export type ProjectImplementation={id:string;title:string;environmentId:string;description?:string;codeRefs:string[]};
export type ProjectModel={title:string;description?:string;modules:ProjectModule[];entities:ProjectEntity[];environments:ProjectEnvironment[];implementations:ProjectImplementation[]};
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
const fail=(message:string):never=>{throw new Error(message);};
function shape(value:unknown,keys:string[],label:string):Record<string,unknown> {
  if(!object(value))return fail(`${label}: ожидается объект.`);
  const extra=Object.keys(value).find(key=>!keys.includes(key));if(extra)fail(`${label}: неизвестное поле ${extra}.`);return value;
}
function text(value:unknown,label:string,max=200):string {if(typeof value!=='string' || !value.trim() || value.length>max)return fail(`${label}: укажите непустой текст до ${max} символов.`);return value;}
function optionalText(value:unknown,label:string):void {if(value!==undefined && (typeof value!=='string' || value.length>4000))fail(`${label}: ожидается текст до 4000 символов.`);}
function strings(value:unknown,label:string):string[] {
  if(!Array.isArray(value) || value.length>500 || value.some(item=>typeof item!=='string' || !item.trim() || item.length>500))return fail(`${label}: ожидается список непустых строк.`);
  if(new Set(value).size!==value.length)fail(`${label}: повторяющиеся значения.`);return value as string[];
}
function entries<T>(value:unknown,label:string,convert:(input:unknown,index:number)=>T):T[] {
  if(!Array.isArray(value) || value.length>2000)return fail(`${label}: ожидается список.`);return value.map(convert);
}
function unique<T>(items:T[],key:(value:T)=>string,label:string):void {if(new Set(items.map(key)).size!==items.length)fail(`${label}: повторяющийся идентификатор.`);}

/** Structural project metadata, deliberately separate from process semantics. */
export function validateProject(value:unknown,processIds:ReadonlySet<string>):ProjectModel {
  const p=shape(value,['title','description','modules','entities','environments','implementations'],'project');text(p.title,'project.title');optionalText(p.description,'project.description');
  const modules=entries(p.modules,'project.modules',(entry,index)=>{
    const x=shape(entry,['id','title','description','processes','dependsOn'],`modules[${index}]`);text(x.id,'module.id');text(x.title,'module.title');optionalText(x.description,'module.description');strings(x.processes,'module.processes');strings(x.dependsOn,'module.dependsOn');return x as unknown as ProjectModule;
  });
  const entities=entries(p.entities,'project.entities',(entry,index)=>{
    const x=shape(entry,['id','title','moduleId','description','dataSchema'],`entities[${index}]`);text(x.id,'entity.id');text(x.title,'entity.title');if(x.moduleId!==null)text(x.moduleId,'entity.moduleId');optionalText(x.description,'entity.description');if(x.dataSchema!==undefined)validateDataDefinitions(x.dataSchema as DataDefinitions);return x as unknown as ProjectEntity;
  });
  const environments=entries(p.environments,'project.environments',(entry,index)=>{
    const x=shape(entry,['id','title','kind','description','technologies','architecture'],`environments[${index}]`);text(x.id,'environment.id');text(x.title,'environment.title');text(x.kind,'environment.kind',80);optionalText(x.description,'environment.description');strings(x.technologies,'environment.technologies');strings(x.architecture,'environment.architecture');return x as unknown as ProjectEnvironment;
  });
  const implementations=entries(p.implementations,'project.implementations',(entry,index)=>{
    const x=shape(entry,['id','title','environmentId','description','codeRefs'],`implementations[${index}]`);const id=text(x.id,'implementation.id');if(!/^[a-f0-9-]{36}$/i.test(id))fail('implementation.id: используйте совместимый ID из 36 символов.');text(x.title,'implementation.title');text(x.environmentId,'implementation.environmentId');optionalText(x.description,'implementation.description');
    for(const ref of strings(x.codeRefs,'implementation.codeRefs'))if(ref.startsWith('/') || /^[a-z]:/i.test(ref) || ref.split(/[\\/]/).some(part=>!part || part==='.' || part==='..') || /[\x00-\x1f]/.test(ref))fail('implementation.codeRefs: путь должен быть относительным и не содержать ..');
    return x as unknown as ProjectImplementation;
  });
  unique(modules,item=>item.id,'Модули');unique(entities,item=>item.id,'Сущности');unique(environments,item=>item.id,'Среды');unique(implementations,item=>item.id,'Реализации');
  const moduleIds=new Set(modules.map(item=>item.id)),environmentIds=new Set(environments.map(item=>item.id)),owner=new Map<string,string>();
  for(const module of modules){
    for(const dependency of module.dependsOn)if(!moduleIds.has(dependency) || dependency===module.id)fail(`Модуль «${module.id}» ссылается на неизвестную или собственную зависимость «${dependency}».`);
    for(const process of module.processes){if(!processIds.has(process))fail(`Процесс «${process}» модуля «${module.id}» не объявлен в документе.`);if(owner.has(process))fail(`Процесс «${process}» уже принадлежит модулю «${owner.get(process)}». Используйте зависимость вместо копии.`);owner.set(process,module.id);}
  }
  for(const entity of entities)if(entity.moduleId!==null && !moduleIds.has(entity.moduleId))fail(`Модуль сущности «${entity.id}» не найден.`);
  for(const implementation of implementations)if(!environmentIds.has(implementation.environmentId))fail(`Среда реализации «${implementation.id}» не найдена.`);
  return p as unknown as ProjectModel;
}

/** A host may resolve bindings outside this document; absence is a warning. */
export function missingImplementations(project:ProjectModel,models:BusinessProcess[]):string[] {
  const known=new Set(project.implementations.map(item=>item.id)),missing=new Set<string>();
  for(const model of models)for(const binding of model.bindings)if(!known.has(binding.implementationId))missing.add(binding.implementationId);
  return [...missing];
}
