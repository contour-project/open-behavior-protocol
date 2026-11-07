export type Position = { offset:number; line:number; column:number };
export type Span = { start:Position; end:Position };
export type ProcessDeclaration = { id:string; model:unknown; span:Span; locations:Record<string,Span> };
export type ProjectDeclaration = { id:string; model:unknown; span:Span; locations:Record<string,Span> };
export type Document = { protocol:'obp'; version:'0.1'; project?:ProjectDeclaration; processes:ProcessDeclaration[] };

export class OBPError extends Error {
  readonly position:Position;
  readonly filename:string;
  constructor(message:string,position:Position,filename='<input>') {
    super(message);this.name='OBPError';this.position=position;this.filename=filename;
  }
}

class Reader {
  private readonly text:string;
  private readonly filename:string;
  private offset=0;
  private line=1;
  private column=1;
  private locations:Record<string,Span>=Object.create(null) as Record<string,Span>;
  constructor(text:string,filename:string) {this.text=text;this.filename=filename;}
  private position():Position {return {offset:this.offset,line:this.line,column:this.column};}
  private error(message:string):never {throw new OBPError(message,this.position(),this.filename);}
  private peek():string {return this.text[this.offset] || '';}
  private take():string {
    const c=this.peek();if(!c)this.error('Неожиданный конец документа');this.offset++;
    if(c==='\n'){this.line++;this.column=1;}else this.column++;return c;
  }
  private space():void {
    for(;;){
      while(/\s/u.test(this.peek()) && this.peek())this.take();
      if(this.text.startsWith('//',this.offset)){while(this.peek() && this.peek()!=='\n')this.take();continue;}
      if(this.text.startsWith('/*',this.offset)){
        this.take();this.take();while(this.peek() && !this.text.startsWith('*/',this.offset))this.take();
        if(!this.peek())this.error('Незавершённый комментарий');this.take();this.take();continue;
      }
      return;
    }
  }
  private expect(char:string):void {this.space();if(this.peek()!==char)this.error(`Ожидалось «${char}»`);this.take();}
  private word():string {
    this.space();const match=/^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.text.slice(this.offset));
    if(!match)this.error('Ожидался идентификатор');for(let i=0;i<match[0].length;i++)this.take();return match[0];
  }
  private quoted():string {
    this.space();const start=this.offset;this.expect('"');let escaped=false;
    while(this.peek()){
      const c=this.take();if(c==='"' && !escaped){
        try {return JSON.parse(this.text.slice(start,this.offset)) as string;}catch {this.error('Некорректная строка');}
      }
      if(c==='\n' || c==='\r')this.error('Перенос строки внутри текста должен быть экранирован');
      if(c==='\\' && !escaped)escaped=true;else escaped=false;
    }
    return this.error('Незавершённая строка');
  }
  private value(path:string,depth:number):unknown {
    this.space();if(depth>1024)this.error('Превышена допустимая глубина документа');const start=this.position();let result:unknown;
    const char=this.peek();
    if(char==='"')result=this.quoted();
    else if(char==='{')result=this.object(path,depth+1);
    else if(char==='['){
      this.take();const items:unknown[]=[];this.space();
      while(this.peek()!==']'){
        if(!this.peek())this.error('Незавершённый список');items.push(this.value(`${path}/${items.length}`,depth+1));this.space();
        if(this.peek()===',' || this.peek()===';'){this.take();this.space();if(this.peek()===']')break;}
        else if(this.peek()!==']')this.error('Ожидалась запятая или конец списка');
      }
      this.take();result=items;
    }else {
      const rest=this.text.slice(this.offset),number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
      if(number){for(let i=0;i<number[0].length;i++)this.take();result=Number(number[0]);if(!Number.isFinite(result))this.error('Число вне поддерживаемой области');}
      else {const word=this.word();if(word==='true')result=true;else if(word==='false')result=false;else if(word==='null')result=null;else this.error(`Неизвестное значение «${word}»`);}
    }
    this.locations[path]={start,end:this.position()};return result;
  }
  private object(path:string,depth:number):Record<string,unknown> {
    this.expect('{');const out:Record<string,unknown>={};this.space();
    while(this.peek()!=='}'){
      if(!this.peek())this.error('Незавершённый объект');const key=this.peek()==='"'?this.quoted():this.word();
      if(Object.hasOwn(out,key))this.error(`Поле «${key}» указано дважды`);this.expect(':');
      const child=`${path}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`,value=this.value(child,depth+1);
      Object.defineProperty(out,key,{value,enumerable:true,writable:true,configurable:true});this.space();
      if(this.peek()===',' || this.peek()===';'){this.take();this.space();if(this.peek()==='}')break;}
      else if(this.peek()!=='}')this.error('Ожидалась запятая или конец объекта');
    }
    this.take();return out;
  }
  document():Document {
    this.space();if(this.word()!=='obp')this.error('Документ должен начинаться с obp 0.1;');this.space();
    if(!this.text.startsWith('0.1',this.offset))this.error('Поддерживается версия протокола 0.1');
    this.take();this.take();this.take();this.expect(';');const processes:ProcessDeclaration[]=[];const ids=new Set<string>();let project:ProjectDeclaration|undefined;
    for(;;){
      this.space();if(!this.peek())break;const start=this.position(),kind=this.word();if(kind!=='process' && kind!=='project')this.error('Ожидалось объявление project или process');this.space();
      const id=this.peek()==='"'?this.quoted():this.word();if(!id.trim() || id.length>200)this.error('Идентификатор должен содержать от 1 до 200 символов');
      if(kind==='process' && ids.has(id))this.error(`Процесс «${id}» объявлен дважды`);if(kind==='process')ids.add(id);if(kind==='project' && project)this.error('Проект объявлен дважды');this.locations=Object.create(null) as Record<string,Span>;
      this.space();if(this.peek()!=='{')this.error('Ожидалось тело объявления');const model=this.value('',0),declaration={id,model,span:{start,end:this.position()},locations:this.locations};
      if(kind==='project')project=declaration;else processes.push(declaration);this.space();if(this.peek()===';')this.take();
    }
    if(!processes.length && !project)this.error('Документ не содержит проекта или процессов');return {protocol:'obp',version:'0.1',...(project?{project}:{}),processes};
  }
}

/** Parse source without changing or guessing any model fields. */
export function parse(source:string,options:{filename?:string}={}):Document {
  if(typeof source!=='string')throw new TypeError('Источник OBP должен быть строкой');
  return new Reader(source,options.filename || '<input>').document();
}
