/**
 * Bearer Token Authentication Middleware
 *
 * Validates `Authorization: Bearer <token>` against CIPHER_API_TOKEN env var.
 * Skips auth when CIPHER_API_TOKEN is empty (dev-mode graceful degradation).
 * Health/liveness endpoints are excluded from auth.
 */

import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { errorResponse, ERROR_CODES } from '../utils/response.js';

const CIPHER_API_TOKEN = process.env.CIPHER_API_TOKEN || '';

// Paths that never require authentication (health probes, discovery)
const PUBLIC_PATHS = ['/health', '/healthz', '/.well-known/'];

function isPublicPath(path: string): boolean {
	return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p));
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const bufA = Buffer.from(a, 'utf-8');
	const bufB = Buffer.from(b, 'utf-8');
	return timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware that validates Bearer token authentication.
 *
 * - If CIPHER_API_TOKEN is not set, auth is skipped (dev mode).
 * - Health endpoints are always public.
 * - All other routes require `Authorization: Bearer <token>`.
 */
export function bearerTokenAuth(req: Request, res: Response, next: NextFunction): void {
	// Skip auth for public paths
	if (isPublicPath(req.path)) {
		next();
		return;
	}

	// Skip auth if no token configured (dev mode)
	if (!CIPHER_API_TOKEN) {
		next();
		return;
	}

	const authHeader = req.headers.authorization;
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		errorResponse(res, ERROR_CODES.UNAUTHORIZED, 'Missing or malformed Authorization header', 401);
		return;
	}

	const token = authHeader.slice(7);
	if (!token || !safeCompare(token, CIPHER_API_TOKEN)) {
		errorResponse(res, ERROR_CODES.UNAUTHORIZED, 'Invalid bearer token', 401);
		return;
	}

	next();
}
