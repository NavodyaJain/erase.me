import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildOpenApi, serializeOpenApi } from '../src/contract/openapi.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking an arbitrary JSON document
export type Json = Record<string, any>;

/** The OpenAPI document as generated from the contract schemas (the committed file is checked to equal it). */
export const spec = buildOpenApi() as Json;
export const specText = serializeOpenApi(spec);

export const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);

/** Validates `value` against a component schema of the spec. Returns the problems found, empty when it conforms. */
export function validateAgainst(name: string, value: unknown): string[] {
  const validate = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/** Which component schema describes a problem response with this code. */
export const problemSchemaFor = (code: string): string =>
  ({ use_form: 'ProblemUseForm', draft_unsafe: 'ProblemDraftUnsafe', validation_failed: 'ProblemValidation' } as Record<string, string>)[code] ?? 'Problem';
