import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { createSession } from '../../src/flue.ts';

describe('Flue session initialization', () => {
	it('creates a usable session for a standalone GitHub Action process', async () => {
		const agent = createAgent(() => ({
			sandbox: local({ env: {} }),
			model: false,
		}));

		const session = await createSession(agent);
		const result = await session.shell('printf ok');

		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout, 'ok');
	});

	it('initializes an unlisted catalog model with the action resolver', async () => {
		const variables = {
			'INPUT_CLOUDFLARE-MODELS': JSON.stringify({
				'anthropic/future-model': {
					api: 'anthropic-messages',
					contextWindow: 200000,
					maxTokens: 1024,
				},
			}),
			CLOUDFLARE_ACCOUNT_ID: 'test-account',
			CLOUDFLARE_API_KEY: 'test-token',
		};
		const previous = Object.fromEntries(
			Object.keys(variables).map((key) => [key, process.env[key]]),
		);
		Object.assign(process.env, variables);
		try {
			const agent = createAgent(() => ({
				sandbox: local({ env: {} }),
				model: 'cloudflare-ai/anthropic/future-model',
			}));
			const session = await createSession(agent);
			assert.equal((await session.shell('printf ok')).stdout, 'ok');
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
