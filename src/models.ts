import type { Api, Model } from '@earendil-works/pi-ai';
import { resolveModel } from '@flue/runtime/internal';
import * as v from 'valibot';

const modelConfig = v.strictObject({
	api: v.picklist(['anthropic-messages', 'openai-responses', 'openai-completions']),
	contextWindow: v.pipe(v.number(), v.integer(), v.minValue(1)),
	maxTokens: v.pipe(v.number(), v.integer(), v.minValue(1)),
	reasoning: v.optional(v.boolean(), false),
	compat: v.optional(
		v.strictObject({
			forceAdaptiveThinking: v.optional(v.boolean()),
			supportsTemperature: v.optional(v.boolean()),
			supportsReasoningEffort: v.optional(v.boolean()),
		}),
	),
});

/** Explicit metadata lets new catalog models work without changing pi-ai's list. */
export function createModelResolver(
	input: string,
	accountId: string | undefined,
	apiKey: string | undefined,
): typeof resolveModel {
	const models = v.parse(v.record(v.string(), modelConfig), JSON.parse(input || '{}'));
	return (name) => {
		if (!name || !name.startsWith('cloudflare-ai/')) return resolveModel(name);
		const id = name.slice('cloudflare-ai/'.length);
		if (!Object.hasOwn(models, id)) {
			throw new Error(`Add metadata for "${id}" to the "cloudflare-models" input.`);
		}
		if (!accountId || !apiKey) {
			throw new Error('cloudflare-ai models require cloudflare-account-id and cloudflare-api-key.');
		}
		const config = models[id];
		const model: Model<Api> = {
			...config,
			id,
			name: id,
			provider: 'cloudflare-ai-gateway',
			baseUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai${config.api === 'anthropic-messages' ? '' : '/v1'}`,
			input: ['text'],
			// Pricing is deliberately unknown; consult Gateway usage for actual cost.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'cf-aig-collect-log-payload': 'false',
			},
		};
		return model;
	};
}
