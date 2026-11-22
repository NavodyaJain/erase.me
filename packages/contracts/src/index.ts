import type { components } from './schema.js';

export type { components, operations, paths } from './schema.js';

/** Every schema of the API contract, by name. */
export type Schemas = components['schemas'];

export type Problem = Schemas['Problem'];
export type ProblemCode = Problem['code'];
export type ProblemUseForm = Schemas['ProblemUseForm'];
export type ProblemDraftUnsafe = Schemas['ProblemDraftUnsafe'];
export type ProblemValidation = Schemas['ProblemValidation'];

export type Me = Schemas['Me'];
export type Inbox = Schemas['Inbox'];
export type Scan = Schemas['Scan'];
export type CompanyItem = Schemas['CompanyItem'];
export type DraftOutcome = Schemas['DraftOutcome'];
export type RequestListItem = Schemas['RequestListItem'];
export type RequestView = Schemas['RequestView'];
export type SendResponse = Schemas['SendResponse'];
