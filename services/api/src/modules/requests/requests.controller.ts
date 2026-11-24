import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, Problems } from '../../common/errors.js';
import { ApproveBody, CreateDraftsBody, EditDraftBody, OutcomeBody, RequestParams, SubmittedBody, idempotencyKey } from '../../contract/schemas.js';
import type { RequestsService } from './requests.service.js';

export interface RequestsRoutesDeps {
  requests: RequestsService;
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export const requestsRoutes: FastifyPluginAsync<RequestsRoutesDeps> = async (app, { requests, requireUser }) => {
  const userId = (request: FastifyRequest): string => {
    if (!request.auth) throw Problems.unauthorized();
    return request.auth.user.id; // from the session, never from the request
  };

  // Batch create (TRD 6.3). Always 200: each company has its own outcome.
  app.post('/v1/requests/drafts', { preHandler: requireUser }, async (request) => {
    const body = CreateDraftsBody.parse(request.body);
    return { results: await requests.createDrafts(userId(request), body.userCompanyIds, request.id) };
  });

  app.get('/v1/requests', { preHandler: requireUser }, async (request) => ({ requests: await requests.list(userId(request)) }));

  app.get('/v1/requests/:id', { preHandler: requireUser }, async (request) => {
    const { id } = RequestParams.parse(request.params);
    return requests.get(userId(request), id);
  });

  app.patch('/v1/requests/:id/draft', { preHandler: requireUser }, async (request) => {
    const { id } = RequestParams.parse(request.params);
    return requests.editDraft(userId(request), id, EditDraftBody.parse(request.body));
  });

  app.post('/v1/requests/:id/approve', { preHandler: requireUser }, async (request) => {
    const { id } = RequestParams.parse(request.params);
    return requests.approve(userId(request), id, ApproveBody.parse(request.body).draftHash);
  });

  // The person reports what the company answered. Never inferred (PRD F7).
  app.put('/v1/requests/:id/outcome', { preHandler: requireUser }, async (request) => {
    const { id } = RequestParams.parse(request.params);
    return requests.setOutcome(userId(request), id, OutcomeBody.parse(request.body).outcome);
  });

  // The person pasted the draft into the company's web form. Nothing is sent from here.
  app.post('/v1/requests/:id/submitted', { preHandler: requireUser }, async (request) => {
    const { id } = RequestParams.parse(request.params);
    return requests.markSubmitted(userId(request), id, SubmittedBody.parse(request.body).draftHash);
  });

  app.post('/v1/requests/:id/close', { preHandler: requireUser }, async (request) => {
    const { id } = RequestParams.parse(request.params);
    return requests.close(userId(request), id);
  });

  app.post('/v1/requests/:id/send', { preHandler: requireUser }, async (request, reply) => {
    const { id } = RequestParams.parse(request.params);
    const header = request.headers['idempotency-key'];
    if (typeof header !== 'string') {
      throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key required', 'Send an Idempotency-Key header so a retry cannot send twice.');
    }
    const key = idempotencyKey.safeParse(header);
    if (!key.success) throw new AppError(400, 'idempotency_key_invalid', 'Invalid Idempotency-Key', 'Use 8 to 128 characters: letters, digits and . _ : -');
    const result = await requests.send(userId(request), id, key.data);
    return reply.status(result.status).send(result.body);
  });
};
