import { Router, Request, Response } from 'express';
import { MemAgent } from '@core/brain/memAgent/index.js';
import { errorResponse, ERROR_CODES } from '../utils/response.js';
import { logger } from '@core/logger/index.js';

/**
 * Memory CRUD routes backing the pmoves-cipher-mcp bridge.
 *
 * The Python client (`pmoves-cipher-mcp/cipher_mcp/client.py`) is the contract:
 *   - POST   /api/memory          -> { id, embedding_id }
 *   - GET    /api/memory/search   -> { results: [...] }
 *   - GET    /api/memory/:id      -> { id, content, category, tags, created_at } | 404
 *   - DELETE /api/memory/:id      -> 2xx on success
 *
 * The client parses these fields at the TOP level, so success bodies are returned
 * as RAW JSON rather than the house `successResponse` envelope. Error responses
 * keep the house `errorResponse` shape because the client only inspects the
 * status code on failures.
 */

// The vector store keys entries by numeric id. Combine the wall clock with
// random low bits: Date.now() (~1.75e12) * 4096 + rand(0..4095) stays under
// Number.MAX_SAFE_INTEGER (~9.007e15) while giving 4096 slots per millisecond.
// NOTE: the default backend is per-process in-memory, where ids never cross
// instances. For a SHARED persistent backend across horizontally-scaled
// instances, prefer a store-native / DB sequence — this scheme minimises but
// cannot fully eliminate cross-instance id collision.
function generateMemoryId(): number {
	return Date.now() * 4096 + Math.floor(Math.random() * 4096);
}

// Narrow structural type for the subset of VectorStore we use here.
interface StoredResult {
	id: string | number;
	payload: Record<string, unknown>;
}
interface MinimalVectorStore {
	insert(vectors: number[][], ids: number[], payloads: Record<string, unknown>[]): Promise<void>;
	get(id: number): Promise<StoredResult | null>;
	delete(id: number): Promise<void>;
	search(
		query: number[],
		limit?: number,
		filters?: Record<string, unknown>
	): Promise<StoredResult[]>;
	list(filters?: Record<string, unknown>, limit?: number): Promise<[StoredResult[], number]>;
}

function getStore(agent: MemAgent): MinimalVectorStore | null {
	// Pass the 'knowledge' collection type: DualCollectionVectorManager and
	// MultiCollectionVectorManager REQUIRE a collection arg (they throw on
	// undefined), while the single VectorStoreManager.getStore() ignores it.
	const manager = agent.services?.vectorStoreManager as
		| { getStore?: (type?: string) => unknown }
		| undefined;
	return (manager?.getStore?.('knowledge') ?? null) as MinimalVectorStore | null;
}

/**
 * Resolve a vector for the given text. Uses the configured 'default' embedder
 * when embeddings are available; otherwise returns a zero vector sized to the
 * store's configured dimension so inserts still succeed on embedding-less nodes
 * (the exact degraded state this route set closes).
 */
async function resolveVector(agent: MemAgent, text: string): Promise<number[]> {
	const em = agent.services?.embeddingManager;
	if (em?.hasAvailableEmbeddings?.()) {
		const embedder = em.getEmbedder('default');
		if (embedder) {
			return embedder.embed(text);
		}
	}
	// VectorStoreManager.getInfo() nests the dimension under `backend`; tolerate a
	// top-level `dimension` too for safety. Falling back to 1 would break inserts
	// into a non-1-dimensional store, so read the real configured dimension.
	const manager = agent.services?.vectorStoreManager as
		| { getInfo?: () => { backend?: { dimension?: number }; dimension?: number } }
		| undefined;
	const info = manager?.getInfo?.();
	const dim = info?.backend?.dimension ?? info?.dimension ?? 1;
	return new Array(dim).fill(0);
}

export function createMemoryRoutes(agent: MemAgent): Router {
	const router = Router();

	/**
	 * POST /api/memory
	 * Store a memory item.
	 */
	router.post('/', async (req: Request, res: Response) => {
		try {
			const {
				content,
				category = 'context',
				tags = [],
				metadata = {},
				created_at,
			} = req.body ?? {};

			if (typeof content !== 'string' || content.trim() === '') {
				return errorResponse(
					res,
					ERROR_CODES.VALIDATION_ERROR,
					'content is required',
					400,
					undefined,
					req.requestId
				);
			}

			const store = getStore(agent);
			if (!store) {
				return errorResponse(
					res,
					ERROR_CODES.INTERNAL_ERROR,
					'vector store unavailable',
					503,
					undefined,
					req.requestId
				);
			}

			const id = generateMemoryId();
			const createdAt =
				typeof created_at === 'string' && created_at ? created_at : new Date().toISOString();
			const normalizedTags = Array.isArray(tags) ? tags : [];
			const payload = {
				id,
				content,
				category,
				tags: normalizedTags,
				created_at: createdAt,
				metadata: metadata ?? {},
			};

			const vector = await resolveVector(agent, content);
			await store.insert([vector], [id], [payload]);

			return res.status(201).json({ id, embedding_id: id });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error('POST /api/memory failed', { requestId: req.requestId, error: msg });
			return errorResponse(
				res,
				ERROR_CODES.INTERNAL_ERROR,
				`Store failed: ${msg}`,
				500,
				process.env.NODE_ENV === 'development' ? error : undefined,
				req.requestId
			);
		}
	});

	/**
	 * GET /api/memory/search
	 * Search memories. Uses semantic search via the 'default' embedder when
	 * embeddings are available; otherwise falls back to a (recency/limit) list
	 * from the store. Registered BEFORE '/:id' so "search" is not treated as an id.
	 * Optional filters: category (exact match), tags (comma-separated, all-match).
	 */
	router.get('/search', async (req: Request, res: Response) => {
		try {
			const q = typeof req.query.q === 'string' ? req.query.q : '';
			const parsedLimit = Number(req.query.limit);
			const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10;
			const category = typeof req.query.category === 'string' ? req.query.category : undefined;
			const tags =
				typeof req.query.tags === 'string' && req.query.tags
					? req.query.tags
							.split(',')
							.map(t => t.trim())
							.filter(Boolean)
					: undefined;

			const store = getStore(agent);
			if (!store) {
				return errorResponse(
					res,
					ERROR_CODES.INTERNAL_ERROR,
					'vector store unavailable',
					503,
					undefined,
					req.requestId
				);
			}

			const filters: Record<string, unknown> = {};
			if (category) filters.category = category;
			const storeFilters = Object.keys(filters).length ? filters : undefined;

			// Tags aren't a store-native filter (payload.tags is an array), so they're
			// applied in JS after fetch. Widen the candidate pool when a tag filter is
			// present so matches ranked beyond `limit` aren't silently dropped, then
			// slice back to `limit`.
			const hasTagFilter = Boolean(tags && tags.length);
			const fetchLimit = hasTagFilter ? Math.max(limit * 10, 100) : limit;

			const em = agent.services?.embeddingManager;
			let results: StoredResult[];
			if (q && em?.hasAvailableEmbeddings?.()) {
				const embedder = em.getEmbedder('default');
				if (embedder) {
					const vector = await embedder.embed(q);
					results = await store.search(vector, fetchLimit, storeFilters);
				} else {
					results = (await store.list(storeFilters, fetchLimit))[0];
				}
			} else {
				results = (await store.list(storeFilters, fetchLimit))[0];
			}

			let mapped = results.map(toContract);
			if (hasTagFilter) {
				mapped = mapped
					.filter(m => Array.isArray(m.tags) && tags!.every(t => (m.tags as unknown[]).includes(t)))
					.slice(0, limit);
			}

			return res.status(200).json({ results: mapped });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error('GET /api/memory/search failed', { requestId: req.requestId, error: msg });
			return errorResponse(
				res,
				ERROR_CODES.INTERNAL_ERROR,
				`Search failed: ${msg}`,
				500,
				process.env.NODE_ENV === 'development' ? error : undefined,
				req.requestId
			);
		}
	});

	/**
	 * GET /api/memory/:id
	 * Fetch a single memory by id. Returns 404 (client maps 404 -> None).
	 */
	router.get('/:id', async (req: Request, res: Response) => {
		try {
			const id = Number(req.params.id);
			if (!Number.isFinite(id)) {
				return errorResponse(
					res,
					ERROR_CODES.VALIDATION_ERROR,
					'invalid memory id',
					400,
					undefined,
					req.requestId
				);
			}

			const store = getStore(agent);
			if (!store) {
				return errorResponse(
					res,
					ERROR_CODES.INTERNAL_ERROR,
					'vector store unavailable',
					503,
					undefined,
					req.requestId
				);
			}

			const result = await store.get(id);
			if (!result) {
				return errorResponse(
					res,
					ERROR_CODES.NOT_FOUND,
					'memory not found',
					404,
					undefined,
					req.requestId
				);
			}

			return res.status(200).json(toContract(result));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error('GET /api/memory/:id failed', { requestId: req.requestId, error: msg });
			return errorResponse(
				res,
				ERROR_CODES.INTERNAL_ERROR,
				`Get failed: ${msg}`,
				500,
				process.env.NODE_ENV === 'development' ? error : undefined,
				req.requestId
			);
		}
	});

	/**
	 * DELETE /api/memory/:id
	 * Remove a memory by id. Returns 200 on success (client maps 2xx -> true).
	 */
	router.delete('/:id', async (req: Request, res: Response) => {
		try {
			const id = Number(req.params.id);
			if (!Number.isFinite(id)) {
				return errorResponse(
					res,
					ERROR_CODES.VALIDATION_ERROR,
					'invalid memory id',
					400,
					undefined,
					req.requestId
				);
			}

			const store = getStore(agent);
			if (!store) {
				return errorResponse(
					res,
					ERROR_CODES.INTERNAL_ERROR,
					'vector store unavailable',
					503,
					undefined,
					req.requestId
				);
			}

			await store.delete(id);
			return res.status(200).json({ deleted: true });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error('DELETE /api/memory/:id failed', { requestId: req.requestId, error: msg });
			return errorResponse(
				res,
				ERROR_CODES.INTERNAL_ERROR,
				`Delete failed: ${msg}`,
				500,
				process.env.NODE_ENV === 'development' ? error : undefined,
				req.requestId
			);
		}
	});

	return router;
}

/**
 * Map a stored vector-store result to the client-facing memory contract shape.
 */
function toContract(result: StoredResult): {
	id: string | number;
	content: unknown;
	category: unknown;
	tags: unknown;
	created_at: unknown;
} {
	const payload = result.payload ?? {};
	return {
		id: result.id,
		content: payload.content,
		category: payload.category,
		tags: payload.tags ?? [],
		created_at: payload.created_at,
	};
}
