import {NextFunction, Request, Response} from 'express'

const TOKEN_ENV = 'CIPHER_API_TOKEN'

export interface PmovesAuthOptions {
  /** Skip auth when token is unset (dev mode). Default: true */
  skipIfUnset?: boolean
}

export function createPmovesAuthMiddleware(options: PmovesAuthOptions = {}) {
  const {skipIfUnset = true} = options

  return function pmovesAuth(req: Request, res: Response, next: NextFunction): void {
    const expected = process.env[TOKEN_ENV] ?? ''
    if (!expected && skipIfUnset) {
      return next()
    }
    if (!expected) {
      res.status(500).json({error: 'CIPHER_API_TOKEN not set'})
      return
    }
    const header = req.headers.authorization ?? ''
    const match = /^Bearer\s+(.+)$/.exec(header)
    if (!match || match[1] !== expected) {
      res.status(401).json({error: 'Unauthorized'})
      return
    }
    next()
  }
}

export const PUBLIC_PATHS = new Set(['/health', '/healthz', '/.well-known/'])
