import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, Problems } from '../../common/errors.js';
import { isId } from '../../common/ids.js';
import { MAX_DRAFTS_PER_CALL, type RequestsService } from './requests.service.js';

const requestId = z.string().refine((v) => isId('request', v), 'invalid request id');
const userCompanyId = z.string().refine((v) => isId('userCompany', v), 'invalid company id');
const Params = z.object({ id: requestId });
const hash = z.string().regex(/^[0-9a-f]{64}$/, 'invalid draft hash');

const CreateBody = z.object({ userCompanyIds: z.array(userCompanyId).min(1).max(MAX_DRAFTS_PER_CALL) }).strict();
const EditBody = z
  .object({
    baseHash: hash,
    subject: z.string().min(1).max(200).regex(/^[^\r\n]+$/, 'must be one line'),
    body: z.string().min(1).max(20_000),
  })
  .strict();
const ApproveBody = z.object({ draftHash: hash }).strict();
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, 'must be 8 to 128 characters: letters, digits and . _ : -');

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
    const body = CreateBody.parse(request.body);
    return { results: await requests.createDrafts(userId(request), body.userCompanyIds, request.id) };
  });

  app.get('/v1/requests', { preHandler: requireUser }, async (request) => ({ requests: await requests.list(userId(request)) }));

  app.get('/v1/requests/:id', { preHandler: requireUser }, async (request) => {
    const { id } = Params.parse(request.params);
    return requests.get(userId(request), id);
  });

  app.patch('/v1/requests/:id/draft', { preHandler: requireUser }, async (request) => {
    const { id } = Params.parse(request.params);
    return requests.editDraft(userId(request), id, EditBody.parse(request.body));
  });

  app.post('/v1/requests/:id/approve', { preHandler: requireUser }, async (request) => {
    const { id } = Params.parse(request.params);
    return requests.approve(userId(request), id, ApproveBody.parse(request.body).draftHash);
  });

  app.post('/v1/requests/:id/close', { preHandler: requireUser }, async (request) => {
    const { id } = Params.parse(request.params);
    return requests.close(userId(request), id);
  });

  app.post('/v1/requests/:id/send', { preHandler: requireUser }, async (request, reply) => {
    const { id } = Params.parse(request.params);
    const header = request.headers['idempotency-key'];
    if (typeof header !== 'string') {
      throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key required', 'Send an Idempotency-Key header so a retry cannot send twice.');
    }
    const key = IdempotencyKey.safeParse(header);
    if (!key.success) throw new AppError(400, 'idempotency_key_invalid', 'Invalid Idempotency-Key', 'Use 8 to 128 characters: letters, digits and . _ : -');
    const result = await requests.send(userId(request), id, key.data);
    return reply.status(result.status).send(result.body);
  });
};
