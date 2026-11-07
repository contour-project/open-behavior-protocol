/** Encode acyclic API results as definite-length CBOR; OBP source stays text. */
export function encodeCbor(input:unknown):Uint8Array {
  const out:number[]=[],stack=new Set<object>(),encoder=new TextEncoder();
  const push=(...values:number[])=>{out.push(...values);};
  const head=(major:number,number:number|bigint)=>{
    const n=typeof number==='bigint'?number:BigInt(number);
    if(n<0n)throw new RangeError('Negative CBOR length');
    if(n<24n)push((major<<5)|Number(n));
    else if(n<=0xffn)push((major<<5)|24,Number(n));
    else if(n<=0xffffn)push((major<<5)|25,Number(n>>8n),Number(n&255n));
    else if(n<=0xffffffffn)push((major<<5)|26,Number(n>>24n),Number((n>>16n)&255n),Number((n>>8n)&255n),Number(n&255n));
    else if(n<=0xffffffffffffffffn){push((major<<5)|27);for(let shift=56n;shift>=0n;shift-=8n)push(Number((n>>shift)&255n));}
    else throw new RangeError('CBOR integer is too large');
  };
  const write=(value:unknown):void=>{
    if(value===null){push(0xf6);return;}if(value===undefined){push(0xf7);return;}
    if(value===false){push(0xf4);return;}if(value===true){push(0xf5);return;}
    if(typeof value==='number'){
      if(!Number.isFinite(value))throw new TypeError('CBOR requires finite numbers');
      if(Number.isSafeInteger(value)){if(value>=0)head(0,value);else head(1,-1-value);return;}
      const buffer=new ArrayBuffer(8);new DataView(buffer).setFloat64(0,value,false);push(0xfb,...new Uint8Array(buffer));return;
    }
    if(typeof value==='bigint'){if(value>=0n)head(0,value);else head(1,-1n-value);return;}
    if(typeof value==='string'){const bytes=encoder.encode(value);head(3,bytes.length);for(const byte of bytes)push(byte);return;}
    if(value instanceof Uint8Array){head(2,value.length);for(const byte of value)push(byte);return;}
    if(typeof value!=='object')throw new TypeError(`Unsupported CBOR type: ${typeof value}`);
    if(stack.has(value))throw new TypeError('CBOR requires acyclic input');stack.add(value);
    if(Array.isArray(value)){head(4,value.length);for(const item of value)write(item);}
    else {const entries=Object.entries(value);head(5,entries.length);for(const [key,item] of entries){write(key);write(item);}}
    stack.delete(value);
  };
  write(input);return Uint8Array.from(out);
}
