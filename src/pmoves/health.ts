import {Router} from 'express'

import {perAgentAuthHealth} from './auth.js'

export function createHealthRouter(): Router {
  const router = Router()
  const startedAt = Date.now()

  router.get('/health', (_req, res) => {
    // Still 200 when degraded: the healthchecks read the status code, and a
    // restart cannot fix a refused service key. The body says what is wrong.
    const perAgentAuth = perAgentAuthHealth()
    res.json({
      status: perAgentAuth.state === 'unavailable' ? 'degraded' : 'healthy',
      service: 'cipher-pmoves-shim',
      version: '0.1.0',
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      per_agent_auth: perAgentAuth,
    })
  })

  return router
}
