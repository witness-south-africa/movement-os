import {
  handleExtractRequest,
  type Env,
  type ExtractHandlerDeps,
} from './extract-handler.js';
import { OperatorRateLimiterDurableObject } from './rate-limiter.js';
import { createAuthTelemetrySampler } from './auth-telemetry.js';

export { OperatorRateLimiterDurableObject };
export type { Env };

export function createWorker(
  deps: ExtractHandlerDeps = {},
): ExportedHandler<Env> {
  const handlerDeps = {
    ...deps,
    admitAuthTelemetry: deps.admitAuthTelemetry ?? createAuthTelemetrySampler(),
  };
  return {
    async fetch(request, env, context): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname !== '/v1/extract') {
        return Response.json({ reason: 'not_found' }, { status: 404 });
      }
      if (request.method !== 'POST') {
        return Response.json(
          { reason: 'method_not_allowed' },
          {
            status: 405,
            headers: { allow: 'POST' },
          },
        );
      }

      return handleExtractRequest(request, env, handlerDeps, context);
    },
  };
}

export default createWorker();
