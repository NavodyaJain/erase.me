import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Problems } from '../../common/errors.js';
import { isId } from '../../common/ids.js';
import type { CompaniesService } from './companies.service.js';

const Params = z.object({ id: z.string().refine((v) => isId('userCompany', v), 'invalid company id') });

export interface CompaniesRoutesDeps {
  companies: CompaniesService;
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export const companiesRoutes: FastifyPluginAsync<CompaniesRoutesDeps> = async (app, { companies, requireUser }) => {
  const userId = (request: FastifyRequest): string => {
    if (!request.auth) throw Problems.unauthorized();
    return request.auth.user.id; // from the session, never from the request
  };

  app.get('/v1/companies', { preHandler: requireUser }, async (request) => ({ companies: await companies.list(userId(request)) }));

  // PUT and DELETE are idempotent: setting a kept company again, or clearing one that is not kept, changes nothing.
  app.put('/v1/companies/:id/keep', { preHandler: requireUser }, async (request) => {
    const { id } = Params.parse(request.params);
    return { company: await companies.setKeep(userId(request), id, true, request.id) };
  });

  app.delete('/v1/companies/:id/keep', { preHandler: requireUser }, async (request) => {
    const { id } = Params.parse(request.params);
    return { company: await companies.setKeep(userId(request), id, false, request.id) };
  });
};
