// Deliberately separate from the browser-compatible protocol API.
export { checkImplementationExamples } from './conformance.ts';
export type { AdapterOptions, ConformanceCase, ConformanceReport } from './conformance.ts';

/** Optional SMT results supplement, but do not complete, the ordinary report. */
export async function proveFractionalProperties(model:unknown,propertyIds?:string[]) {
  const {validateBusinessProcess}=await import('../business-process.ts');
  const checked=validateBusinessProcess(model);
  const {proveFractionalProperties:prove}=await import('../business-process-smt.ts');
  return prove(checked,propertyIds || checked.properties.map(property=>property.id));
}
