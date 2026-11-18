import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { setIssueType } from '../src/github.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

it('reports GitHub errors when setting an issue type', async () => {
	globalThis.fetch = async () => new Response('Unknown issue type', { status: 422 });

	await assert.rejects(
		setIssueType('owner/repo', 123, 'Feature', 'write-token'),
		/Failed to set issue type \(HTTP 422\): Unknown issue type/,
	);
});
