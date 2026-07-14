import {Router} from 'express'
import {createPmovesAuthMiddleware} from './auth.js'

export function createA2ARouter(): Router {
  const router = Router()

  router.get('/.well-known/agent.json', (req, res) => {
    const auth = createPmovesAuthMiddleware()
    auth(req, res, () => {
      const base = `${req.protocol}://${req.get('host')}`
      res.json({
        name: 'Cipher Memory (PMOVES Shim)',
        description: 'Agent memory service — REST + MCP-over-SSE on ByteRover v3.16.1',
        version: '0.1.0',
        capabilities: ['memory', 'mcp', 'streaming', 'reasoning'],
        endpoints: {
          base,
          api: `${base}/api/memory`,
          mcp_sse: `${base}/mcp/sse`,
          health: `${base}/health`,
        },
        protocols: ['http', 'mcp-sse'],
        timestamp: new Date().toISOString(),
      })
    })
  })

  router.get('/.well-known/appspecific/com.chrome.devtools.json', (_req, res) => {
    res.status(204).end()
  })

  return router
}
