import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { createMemoryRoutes } from '../routes/memory.js';
import { InMemoryBackend } from '@core/vector_storage/backend/in-memory.js';

const DIM = 3;

function makeStore(): InMemoryBackend {
	return new InMemoryBackend({ collectionName: 'test-memory', dimension: DIM });
}

interface FakeAgentOpts {
	embedder?: { embed: (text: string) => Promise<number[]> };
}

function makeAgent(store: InMemoryBackend, opts: FakeAgentOpts = {}): any {
	return {
		services: {
			vectorStoreManager: {
				getStore: () => store,
				getInfo: () => ({ dimension: store.getDimension() }),
			},
			embeddingManager: opts.embedder
				? { hasAvailableEmbeddings: () => true, getEmbedder: () => opts.embedder }
				: { hasAvailableEmbeddings: () => false, getEmbedder: () => undefined },
		},
	};
}

function makeApp(agent: any): Express {
	const app = express();
	app.use(express.json());
	app.use('/api/memory', createMemoryRoutes(agent));
	return app;
}

describe('POST /api/memory', () => {
	let store: InMemoryBackend;
	let app: Express;

	beforeEach(async () => {
		store = makeStore();
		await store.connect();
		app = makeApp(makeAgent(store));
	});

	it('stores a memory and returns a numeric id at the top level (no envelope)', async () => {
		const res = await request(app)
			.post('/api/memory')
			.send({ content: 'hello knuckles', category: 'context', tags: ['a', 'b'] });

		expect(res.status).toBe(201);
		// Contract: client reads data["id"] and data.get("embedding_id") at TOP level
		expect(typeof res.body.id).toBe('number');
		expect(res.body).not.toHaveProperty('data');
		expect(res.body.embedding_id).toBe(res.body.id);
	});

	it('rejects a request with no content (400)', async () => {
		const res = await request(app).post('/api/memory').send({ category: 'context' });
		expect(res.status).toBe(400);
	});
});

describe('GET /api/memory/:id', () => {
	let store: InMemoryBackend;
	let app: Express;

	beforeEach(async () => {
		store = makeStore();
		await store.connect();
		app = makeApp(makeAgent(store));
	});

	it('returns a stored memory with contract fields at the top level', async () => {
		const created = await request(app)
			.post('/api/memory')
			.send({ content: 'remember me', category: 'decision', tags: ['x'] });
		const id = created.body.id;

		const res = await request(app).get(`/api/memory/${id}`);

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			id,
			content: 'remember me',
			category: 'decision',
			tags: ['x'],
		});
		expect(typeof res.body.created_at).toBe('string');
		expect(res.body).not.toHaveProperty('data');
	});

	it('returns 404 for an unknown id (client treats 404 as None)', async () => {
		const res = await request(app).get('/api/memory/999999999');
		expect(res.status).toBe(404);
	});
});

describe('DELETE /api/memory/:id', () => {
	let store: InMemoryBackend;
	let app: Express;

	beforeEach(async () => {
		store = makeStore();
		await store.connect();
		app = makeApp(makeAgent(store));
	});

	it('deletes a stored memory (2xx) and a subsequent get returns 404', async () => {
		const created = await request(app).post('/api/memory').send({ content: 'delete me' });
		const id = created.body.id;

		const del = await request(app).delete(`/api/memory/${id}`);
		expect(del.status).toBeGreaterThanOrEqual(200);
		expect(del.status).toBeLessThan(300);

		const after = await request(app).get(`/api/memory/${id}`);
		expect(after.status).toBe(404);
	});
});

describe('GET /api/memory/search', () => {
	let store: InMemoryBackend;
	let app: Express;

	beforeEach(async () => {
		store = makeStore();
		await store.connect();
		app = makeApp(makeAgent(store));
	});

	it('returns a top-level results array (no-embedder list fallback)', async () => {
		await request(app).post('/api/memory').send({ content: 'alpha note', category: 'context' });
		await request(app).post('/api/memory').send({ content: 'beta note', category: 'context' });

		const res = await request(app).get('/api/memory/search').query({ q: 'note', limit: 10 });

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.results)).toBe(true);
		expect(res.body.results.length).toBe(2);
		const contents = res.body.results.map((r: any) => r.content).sort();
		expect(contents).toEqual(['alpha note', 'beta note']);
		// contract shape per item
		expect(res.body.results[0]).toHaveProperty('id');
		expect(res.body.results[0]).toHaveProperty('created_at');
	});

	it('filters by category', async () => {
		await request(app).post('/api/memory').send({ content: 'keep', category: 'decision' });
		await request(app).post('/api/memory').send({ content: 'drop', category: 'context' });

		const res = await request(app)
			.get('/api/memory/search')
			.query({ q: 'x', category: 'decision' });

		expect(res.status).toBe(200);
		expect(res.body.results.map((r: any) => r.content)).toEqual(['keep']);
	});

	it('uses the embedder + store.search when embeddings are available', async () => {
		const embedStore = makeStore();
		await embedStore.connect();
		const embed = vi.fn(async (_text: string) => [0.1, 0.2, 0.3]);
		const embedApp = makeApp(makeAgent(embedStore, { embedder: { embed } }));

		await request(embedApp)
			.post('/api/memory')
			.send({ content: 'semantic item', category: 'context' });

		const res = await request(embedApp).get('/api/memory/search').query({ q: 'semantic' });

		expect(res.status).toBe(200);
		// embedder called for both the insert and the query
		expect(embed).toHaveBeenCalled();
		expect(res.body.results.some((r: any) => r.content === 'semantic item')).toBe(true);
	});
});
