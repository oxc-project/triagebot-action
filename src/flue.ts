import type { CreatedAgent, FlueSession } from '@flue/runtime';
import {
	Bash,
	bashFactoryToSessionEnv,
	createFlueContext,
	InMemoryFs,
	InMemorySessionStore,
} from '@flue/runtime/internal';
import { createFlueEventLogger } from './flue-logging.ts';
import { getInput } from './input.ts';
import { createModelResolver } from './models.ts';

const defaultStore = new InMemorySessionStore();

async function createDefaultEnv() {
	const fs = new InMemoryFs();
	return bashFactoryToSessionEnv(
		() =>
			new Bash({
				fs,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
	);
}

export async function createSession(agent: CreatedAgent): Promise<FlueSession> {
	const ctx = createFlueContext({
		id: `triagebot-action-${process.env.GITHUB_RUN_ID ?? Date.now()}-${
			process.env.GITHUB_RUN_ATTEMPT ?? '0'
		}`,
		payload: {},
		env: process.env,
		agentConfig: {
			systemPrompt: '',
			skills: {},
			subagents: {},
			model: undefined,
			resolveModel: createModelResolver(
				getInput('cloudflare-models'),
				process.env.CLOUDFLARE_ACCOUNT_ID,
				process.env.CLOUDFLARE_API_KEY,
			),
		},
		createDefaultEnv,
		defaultStore,
	});
	const logger = createFlueEventLogger();
	ctx.setEventCallback((event) => logger.present(event));
	const harness = await ctx.init(agent);
	return harness.session();
}
