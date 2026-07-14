import {Router} from 'express'

export function createHealthRouter(): Router {
  const router = Router()
  const startedAt = Date.now()

  router.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      service: 'cipher-pmoves-shim',
      version: '0.1.0',
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    })
  })

  return router
}
