import { Router, Request, Response } from 'express';
import { MemAgent } from '@core/brain/memAgent/index.js';
import { successResponse, errorResponse, ERROR_CODES } from '../utils/response.js';
import { logger } from '@core/logger/index.js';

/**
 * Get the first available embedder from the embedding manager.
 * Returns null if no embedder is available.
 */
function getEmbedder(agent: MemAgent) {
	const embeddingManager = agent.services.embeddingManager;
	if (!embeddingManager) return null;
	const embedders = embeddingManager.getAllEmbedders();
	if (embedders.size === 0) return null;
	return embedders.values().next().value;
}

/**
 * Get the vector store from the vector store manager.
 * Returns null if not connected.
 */
function getVectorStore(agent: MemAgent) {
	return agent.services.vectorStoreManager.getStore();
}

/**
 * Generate a unique integer ID for vector storage.
 * Uses timestamp-based approach for uniqueness without requiring state.
 */
function generateId(): number {
	return Date.now();
}

/**
 * Parse a string ID from the API into an integer for vector store lookup.
 */
function parseId(idStr: string): number {
	const parsed = parseInt(idStr, 10);
	if (isNaN(parsed)) throw new Error(`Invalid memory ID: ${idStr}`);
	return parsed;
}

export function createMemoryRoutes(agent: MemAgent): Router {
	const router = Router();

	/**
	 * POST /api/memory
	 * Store a memory: generate embedding → store vector with payload → return ID
	 */
	router.post('/', async (req: Request, res: Response) => {
		try {
			const { content, category, tags, metadata, created_at } = req.body;

			if (!content || typeof content !== 'string') {
				return errorResponse(res, ERROR_CODES.VALIDATION_ERROR, 'content is required and must be a string', 400);
			}

			const embedder = getEmbedder(agent);
		if (!embedder) {
				return errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'No embedding model available', 503);
			}

			const store = getVectorStore(agent);
			if (!store) {
				return errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'Vector store not connected', 503);
			}

			const embedding = await embedder.embed(content);
			const id = generateId();

			const payload: Record<string, any> = {
				content,
				category: category || null,
				tags: Array.isArray(tags) ? tags : [],
				created_at: created_at || new Date().toISOString(),
			};
			if (metadata && typeof metadata === 'object') {
				payload.metadata = metadata;
			}

			await store.insert([embedding], [id], [payload]);

			logger.info('Memory stored', { id: String(id), category, tagCount: payload.tags.length });

			successResponse(res, {
				id: String(id),
				content,
				category: payload.category,
				tags: payload.tags,
				created_at: payload.created_at,
				embedding_id: null,
			});
		} catch (error) {
			logger.error('Failed to store memory', { error: error instanceof Error ? error.message : String(error) });
			errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'Failed to store memory', 500);
		}
	});

	/**
	 * GET /api/memory/search
	 * Search memories: generate embedding from query → search vector store → return matching payloads
	 */
	router.get('/search', async (req: Request, res: Response) => {
		try {
			const { q, limit, category, tags } = req.query;

			if (!q || typeof q !== 'string') {
				return errorResponse(res, ERROR_CODES.VALIDATION_ERROR, 'q query parameter is required', 400);
			}

			const embedder = getEmbedder(agent);
			if (!embedder) {
				return errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'No embedding model available', 503);
			}

			const store = getVectorStore(agent);
			if (!store) {
				return errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'Vector store not connected', 503);
			}

			const queryVector = await embedder.embed(q);
			const resultLimit = limit ? parseInt(String(limit), 10) : 10;

			// Build optional filters
			const filters: Record<string, any> = {};
			if (category && typeof category === 'string') {
				filters.category = category;
			}
			if (tags && typeof tags === 'string') {
				const tagList = tags.split(',').map((t: string) => t.trim()).filter(Boolean);
				if (tagList.length > 0) {
					filters.tags = { any: tagList };
				}
			}

			const results = await store.search(
				queryVector,
				isNaN(resultLimit) ? 10 : resultLimit,
				Object.keys(filters).length > 0 ? filters : undefined
			);

			const mapped = results.map((r) => ({
				id: String(r.id),
				content: r.payload?.content,
				category: r.payload?.category,
				tags: r.payload?.tags || [],
				created_at: r.payload?.created_at,
			}));

			logger.info('Memory search completed', { query: q, resultCount: mapped.length });

			successResponse(res, { results: mapped });
		} catch (error) {
			logger.error('Failed to search memories', { error: error instanceof Error ? error.message : String(error) });
			errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'Failed to search memories', 500);
		}
	});

	/**
	 * GET /api/memory/:id
	 * Retrieve a memory by ID
	 */
	router.get('/:id', async (req: Request, res: Response) => {
		try {
			const store = getVectorStore(agent);
			if (!store) {
				return errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'Vector store not connected', 503);
			}

			let numericId: number;
			try {
				numericId = parseId(req.params.id);
			} catch {
				return errorResponse(res, ERROR_CODES.BAD_REQUEST, 'Invalid memory ID format', 400);
			}

			const result = await store.get(numericId);
			if (!result) {
				return errorResponse(res, ERROR_CODES.NOT_FOUND, 'Memory not found', 404);
			}

			successResponse(res, {
				id: String(result.id),
				content: result.payload?.content,
				category: result.payload?.category,
				tags: result.payload?.tags || [],
				created_at: result.payload?.created_at,
			});
		} catch (error) {
			logger.error('Failed to get memory', { error: error instanceof Error ? error.message : String(error) });
			errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'Failed to get memory', 500);
		}
	});

	/**
	 * DELETE /api/memory/:id
	 * Delete a memory by ID
	 */
	router.delete('/:id', async (req: Request, res: Response) => {
		try {
			const store = getVectorStore(agent);
			if (!store) {
				return errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'Vector store not connected', 503);
			}

			let numericId: number;
			try {
				numericId = parseId(req.params.id);
			} catch {
				return errorResponse(res, ERROR_CODES.BAD_REQUEST, 'Invalid memory ID format', 400);
			}

			await store.delete(numericId);

			logger.info('Memory deleted', { id: req.params.id });

			successResponse(res, { success: true });
		} catch (error) {
			logger.error('Failed to delete memory', { error: error instanceof Error ? error.message : String(error) });
			errorResponse(res, ERROR_CODES.INTERNAL_ERROR, 'Failed to delete memory', 500);
		}
	});

	return router;
}
