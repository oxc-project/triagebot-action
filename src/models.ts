import type { Api, Model } from '@earendil-works/pi-ai';
import { resolveModel } from '@flue/runtime/internal';
import * as v from 'valibot';

const modelConfig = v.strictObject({
	api: v.picklist(['anthropic-messages', 'openai-responses', 'openai-completions']),
	contextWindow: v.pipe(v.number(), v.integer(), v.minValue(1)),
	maxTokens: v.pipe(v.number(), v.integer(), v.minValue(1)),
	reasoning: v.optional(v.boolean(), false),
	thinkingLevelMap: v.optional(
		v.record(
			v.picklist(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']),
			v.nullable(v.string()),
		),
	),
	compat: v.optional(
		v.strictObject({
			forceAdaptiveThinking: v.optional(v.boolean()),
			supportsTemperature: v.optional(v.boolean()),
			supportsReasoningEffort: v.optional(v.boolean()),
			maxTokensField: v.optional(v.picklist(['max_tokens', 'max_completion_tokens'])),
			requiresReasoningContentOnAssistantMessages: v.optional(v.boolean()),
		}),
	),
});

export const DEFAULT_MODEL = 'cloudflare-ai/moonshotai/kimi-k3.1-pro';

const defaultModels: Record<string, v.InferOutput<typeof modelConfig>> = {
	'moonshotai/kimi-k3.1-pro': {
		api: 'openai-completions',
		contextWindow: 1_048_576,
		maxTokens: 16_384,
		reasoning: true,
		// K3.1 always reasons and accepts low/high/max, rather than medium.
		thinkingLevelMap: {
			off: null,
			minimal: 'low',
			low: 'low',
			medium: 'high',
			high: 'high',
			xhigh: 'max',
		},
		compat: {
			supportsReasoningEffort: true,
			maxTokensField: 'max_tokens',
			requiresReasoningContentOnAssistantMessages: true,
		},
	},
};

/** Explicit metadata lets new catalog models work without changing pi-ai's list. */
export function createModelResolver(
	input: string,
	accountId: string | undefined,
	apiKey: string | undefined,
): typeof resolveModel {
	const models = {
		...defaultModels,
		...v.parse(v.record(v.string(), modelConfig), JSON.parse(input || '{}')),
	};
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
