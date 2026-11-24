import {Router} from 'express'

import {createPmovesAuthMiddleware} from './auth.js'

export function createA2ARouter(): Router {
  const router = Router()

  router.get('/.well-known/agent.json', (req, res) => {
    const auth = createPmovesAuthMiddleware()
    auth(req, res, () => {
      const base = `${req.protocol}://${req.get('host')}`
      res.json({
        capabilities: ['memory', 'mcp', 'streaming', 'reasoning'],
        description: 'Agent memory service — REST + MCP-over-SSE on ByteRover v3.16.1',
        endpoints: {
          api: `${base}/api/memory`,
          base,
          health: `${base}/health`,
          mcp_sse: `${base}/mcp/sse`,
        },
        name: 'Cipher Memory (PMOVES Shim)',
        protocols: ['http', 'mcp-sse'],
        timestamp: new Date().toISOString(),
        version: '0.1.0',
      })
    })
  })

  router.get('/.well-known/appspecific/com.chrome.devtools.json', (_req, res) => {
    res.status(204).end()
  })

  return router
}
