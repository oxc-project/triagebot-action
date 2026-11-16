import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { completeSimple, Type } from '@earendil-works/pi-ai';
import { createModelResolver, DEFAULT_MODEL } from '../src/models.ts';

const config = {
	'anthropic/claude-opus-5.5': {
		api: 'anthropic-messages',
		contextWindow: 1_000_000,
		maxTokens: 16_384,
		reasoning: true,
		compat: { forceAdaptiveThinking: true, supportsTemperature: false },
	},
	'openai/gpt-6.1-sol': {
		api: 'openai-responses',
		contextWindow: 200_000,
		maxTokens: 16_384,
		reasoning: true,
	},
};
const resolve = createModelResolver(JSON.stringify(config), 'test-account', 'test-token');
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function sse(events: object[]) {
	return new Response(
		events
			.map((event) => {
				const type = (event as { type?: string }).type;
				return `${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
			})
			.join(''),
		{
			headers: { 'content-type': 'text/event-stream' },
		},
	);
}

describe('Cloudflare catalog models', () => {
	for (const name of [DEFAULT_MODEL, 'cloudflare-ai/moonshotai/kimi-k3.1-pro']) {
		it(`round-trips ${name} reasoning and streamed tools`, async () => {
			const model = createModelResolver('', 'test-account', 'test-token')(name);
			assert.ok(model);
			assert.equal(model.contextWindow, 1_048_576);
			const requests: Record<string, any>[] = [];
			globalThis.fetch = async (url, init) => {
				assert.equal(
					String(url),
					'https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions',
				);
				assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
				const body = JSON.parse(String(init?.body));
				assert.equal(body.model, model.id);
				assert.equal(body.reasoning_effort, 'high');
				assert.equal(body.max_tokens, 256);
				assert.equal(body.max_completion_tokens, undefined);
				requests.push(body);
				const chunk = (delta: object, finish_reason: string | null = null) => ({
					id: 'chatcmpl_test',
					object: 'chat.completion.chunk',
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta, finish_reason }],
				});
				return requests.length === 1
					? sse([
							chunk({ role: 'assistant', reasoning_content: 'Check the boundary cases.' }),
							chunk({
								tool_calls: [
									{
										index: 0,
										id: 'call_test',
										type: 'function',
										function: { name: 'submit_fix', arguments: '{"source":' },
									},
								],
							}),
							chunk({ tool_calls: [{ index: 0, function: { arguments: '"test fix"}' } }] }),
							chunk({}, 'tool_calls'),
						])
					: sse([chunk({ role: 'assistant', content: 'VERIFIED' }), chunk({}, 'stop')]);
			};
			const user = { role: 'user' as const, content: 'Fix this code.', timestamp: Date.now() };
			const tools = [
				{
					name: 'submit_fix',
					description: 'Submit a fix.',
					parameters: Type.Object({ source: Type.String() }),
				},
			];
			// Flue's default is medium; these models accept low/high/max.
			const options = { apiKey: 'test-token', reasoning: 'medium' as const, maxTokens: 256 };
			const first = await completeSimple(model, { messages: [user], tools }, options);
			assert.equal(first.stopReason, 'toolUse', first.errorMessage);
			const call = first.content.find((part) => part.type === 'toolCall');
			assert.ok(call);
			assert.deepEqual(call.arguments, { source: 'test fix' });
			const reply = await completeSimple(
				model,
				{
					messages: [
						user,
						first,
						{
							role: 'toolResult',
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: 'text', text: 'Tests passed.' }],
							isError: false,
							timestamp: Date.now(),
						},
					],
					tools,
				},
				options,
			);
			assert.equal(reply.stopReason, 'stop', reply.errorMessage);
			assert.ok(reply.content.some((part) => part.type === 'text' && part.text === 'VERIFIED'));
			const assistant = requests[1].messages.find((message: any) => message.role === 'assistant');
			assert.equal(assistant.reasoning_content, 'Check the boundary cases.');
			assert.equal(assistant.tool_calls[0].id, call.id);
			assert.equal(requests[1].messages.at(-1).tool_call_id, call.id);
		});
	}

	it('keeps existing model selection and disabled models working', () => {
		assert.equal(
			resolve('cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6')?.api,
			'openai-completions',
		);
		assert.equal(resolve(false), undefined);
		assert.equal(resolve(undefined), undefined);
	});

	it('accepts a future model ID with explicit metadata', () => {
		const future = createModelResolver(
			JSON.stringify({ 'anthropic/future-model': config['anthropic/claude-opus-5.5'] }),
			'test-account',
			'test-token',
		);
		assert.equal(future('cloudflare-ai/anthropic/future-model')?.id, 'anthropic/future-model');
	});

	it('rejects missing metadata, credentials, and invalid protocols or limits', () => {
		assert.throws(() => resolve('cloudflare-ai/unknown'), /Add metadata/);
		const noKey = createModelResolver(JSON.stringify(config), 'test-account', undefined);
		assert.throws(() => noKey('cloudflare-ai/anthropic/claude-opus-5.5'), /require/);
		for (const overrides of [{ api: 'unknown' }, { maxTokens: 0 }, { contextWindow: -1 }]) {
			assert.throws(() =>
				createModelResolver(
					JSON.stringify({ model: { ...config['anthropic/claude-opus-5.5'], ...overrides } }),
					'test-account',
					'test-token',
				),
			);
		}
	});

	it('round-trips streamed Anthropic tool calls and thinking signatures through the account API', async () => {
		const model = resolve('cloudflare-ai/anthropic/claude-opus-5.5');
		assert.ok(model);
		const requests: Record<string, any>[] = [];
		globalThis.fetch = async (url, init) => {
			assert.equal(
				String(url),
				'https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/messages',
			);
			const headers = new Headers(init?.headers);
			assert.equal(headers.get('authorization'), 'Bearer test-token');
			assert.equal(headers.get('x-api-key'), null);
			assert.equal(headers.get('cf-aig-collect-log-payload'), 'false');
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, 'anthropic/claude-opus-5.5');
			assert.equal(body.thinking.type, 'adaptive');
			assert.equal(body.output_config.effort, 'high');
			assert.equal(body.temperature, undefined);
			requests.push(body);
			const first = requests.length === 1;
			return sse([
				{
					type: 'message_start',
					message: {
						id: 'msg_test',
						role: 'assistant',
						content: [],
						usage: { input_tokens: 4, output_tokens: 0 },
					},
				},
				...(first
					? [
							{
								type: 'content_block_start',
								index: 0,
								content_block: { type: 'thinking', thinking: '' },
							},
							{
								type: 'content_block_delta',
								index: 0,
								delta: { type: 'thinking_delta', thinking: 'Check the boundary cases.' },
							},
							{
								type: 'content_block_delta',
								index: 0,
								delta: { type: 'signature_delta', signature: 'test-signature' },
							},
							{ type: 'content_block_stop', index: 0 },
							{
								type: 'content_block_start',
								index: 1,
								content_block: { type: 'tool_use', id: 'tool_test', name: 'submit_fix', input: {} },
							},
							{
								type: 'content_block_delta',
								index: 1,
								delta: { type: 'input_json_delta', partial_json: '{"source":"test fix"}' },
							},
							{ type: 'content_block_stop', index: 1 },
						]
					: [
							{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
							{
								type: 'content_block_delta',
								index: 0,
								delta: { type: 'text_delta', text: 'VERIFIED' },
							},
							{ type: 'content_block_stop', index: 0 },
						]),
				{
					type: 'message_delta',
					delta: { stop_reason: first ? 'tool_use' : 'end_turn' },
					usage: { output_tokens: 8 },
				},
				{ type: 'message_stop' },
			]);
		};
		const user = { role: 'user' as const, content: 'Fix this code.', timestamp: Date.now() };
		const tools = [
			{
				name: 'submit_fix',
				description: 'Return a fix.',
				parameters: Type.Object({ source: Type.String() }),
			},
		];
		const options = { apiKey: 'test-token', reasoning: 'high' as const, maxTokens: 256 };
		const first = await completeSimple(model, { messages: [user], tools }, options);
		assert.equal(first.stopReason, 'toolUse', first.errorMessage);
		const call = first.content.find((part) => part.type === 'toolCall');
		assert.ok(call);
		assert.deepEqual(call.arguments, { source: 'test fix' });
		const second = await completeSimple(
			model,
			{
				messages: [
					user,
					first,
					{
						role: 'toolResult',
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: 'text', text: 'Tests passed.' }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools,
			},
			options,
		);
		assert.equal(second.stopReason, 'stop', second.errorMessage);
		assert.ok(second.content.some((part) => part.type === 'text' && part.text === 'VERIFIED'));
		const assistant = requests[1].messages.find((message: any) => message.role === 'assistant');
		assert.ok(assistant.content.some((part: any) => part.signature === 'test-signature'));
		assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, call.id);
	});

	it('sends OpenAI Responses requests to the account API with reasoning enabled', async () => {
		const model = resolve('cloudflare-ai/openai/gpt-6.1-sol');
		assert.ok(model);
		globalThis.fetch = async (url, init) => {
			assert.equal(
				String(url),
				'https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/responses',
			);
			assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, 'openai/gpt-6.1-sol');
			assert.equal(body.reasoning.effort, 'high');
			assert.equal(body.store, false);
			const item = {
				type: 'message',
				id: 'msg_test',
				role: 'assistant',
				content: [{ type: 'output_text', text: 'OK', annotations: [] }],
			};
			return sse([
				{ type: 'response.output_item.added', item: { ...item, content: [] }, output_index: 0 },
				{ type: 'response.output_item.done', item, output_index: 0 },
				{
					type: 'response.completed',
					response: { id: 'resp_test', status: 'completed', output: [item] },
				},
			]);
		};
		const reply = await completeSimple(
			model,
			{
				messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }],
			},
			{ apiKey: 'test-token', reasoning: 'high', maxTokens: 256 },
		);
		assert.equal(reply.stopReason, 'stop', reply.errorMessage);
		assert.ok(reply.content.some((part) => part.type === 'text' && part.text === 'OK'));
	});
});
