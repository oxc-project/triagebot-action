import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ActionContext } from '../../src/context.ts';
import { handleRetriage } from '../../src/handlers/retriage.ts';
import { handleTriage } from '../../src/handlers/triage.ts';
import { handleVerifyFix } from '../../src/handlers/verify-fix.ts';
import { labelConfigFromInputs } from '../../src/labels.ts';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalPath = process.env.PATH;
let tempDir: string | null = null;

afterEach(() => {
	process.chdir(originalCwd);
	globalThis.fetch = originalFetch;
	if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

function run(command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

function setupRepo(): string {
	tempDir = mkdtempSync(join(tmpdir(), 'triagebot-e2e-'));
	mkdirSync(join(tempDir, '.agents', 'skills', 'triage'), { recursive: true });
	const skillDir = join(tempDir, '.agents', 'skills', 'triage');
	writeFileSync(
		join(skillDir, 'SKILL.md'),
		'---\nname: triage\ndescription: Triage a bug report.\n---\n\n# Triage\n',
	);
	writeFileSync(join(skillDir, 'reproduce.md'), '# Reproduce\n');
	writeFileSync(join(skillDir, 'diagnose.md'), '# Diagnose\n');
	writeFileSync(join(skillDir, 'verify.md'), '# Verify\n');
	writeFileSync(join(skillDir, 'fix.md'), '# Fix\n');
	mkdirSync(join(tempDir, 'packages', 'astro', 'src'), { recursive: true });
	writeFileSync(join(tempDir, 'packages', 'astro', 'src', 'index.ts'), 'export const value = 1;\n');
	writeFileSync(join(tempDir, 'README.md'), '# fixture\n');
	run('git', ['init', '-b', 'main'], tempDir);
	run('git', ['config', 'user.email', 'test@example.com'], tempDir);
	run('git', ['config', 'user.name', 'Test'], tempDir);
	run('git', ['add', '.'], tempDir);
	run('git', ['commit', '-m', 'initial'], tempDir);
	process.chdir(tempDir);
	return skillDir;
}

function configureLocalPushRemote(): void {
	assert.ok(tempDir);
	const remoteDir = join(tempDir, '.git', 'remote.git');
	run('git', ['init', '--bare', remoteDir], tempDir);
	run(
		'git',
		[
			'config',
			`url.file://${remoteDir}.insteadOf`,
			'https://x-access-token:write-token@github.com/withastro/astro.git',
		],
		tempDir,
	);
}

function installFakePnpm(url: string): void {
	assert.ok(tempDir);
	const binDir = join(tempDir, '.git', 'bin');
	mkdirSync(binDir, { recursive: true });
	const pnpmPath = join(binDir, 'pnpm');
	writeFileSync(
		pnpmPath,
		`#!/bin/sh\nprintf '%s' '{"packages":[{"url":"${url}"}]}' > preview-release.json\nexit 0\n`,
	);
	chmodSync(pnpmPath, 0o755);
	process.env.PATH = `${binDir}:${originalPath ?? ''}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function anthropicStream(toolInput: unknown): Response {
	const encoder = new TextEncoder();
	const body = [
		{
			type: 'message_start',
			message: {
				id: 'msg_test',
				type: 'message',
				role: 'assistant',
				content: [],
				model: 'claude-sonnet-4-6',
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
		{
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_test', name: 'finish', input: {} },
		},
		{
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
		},
		{ type: 'content_block_stop', index: 0 },
		{
			type: 'message_delta',
			delta: { stop_reason: 'tool_use', stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: 'message_stop' },
	]
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join('');

	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(body));
				controller.close();
			},
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } },
	);
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

function splitComment(login: string, body: string) {
	return {
		user: { login },
		author_association: 'NONE',
		body,
		created_at: '2026-01-01T00:00:00Z',
	};
}

describe('mocked triage flow', () => {
	for (const report of ['Bug', 'Feature', 'Task', 'split follow-up'] as const) {
		const splitChild = report === 'split follow-up';
		const issueType = report === 'split follow-up' ? 'Bug' : report;
		it(`sets ${issueType} type for a ${report} report`, async () => {
			const triageSkill = setupRepo();
			process.env.ANTHROPIC_API_KEY = 'test-key';
			const comments: string[] = [];
			const addedLabels: string[][] = [];
			let removedLabel: string | null = null;
			const issueTypes: string[] = [];
			let anthropicCalls = 0;

			globalThis.fetch = async (input, init) => {
				const url = String(input);
				if (url.startsWith('https://api.anthropic.com/')) {
					anthropicCalls += 1;
					if (anthropicCalls > 5) {
						throw new Error('Too many mocked Anthropic calls');
					}
					if (!splitChild && anthropicCalls === 1) return anthropicStream({ followUps: [] });
					if (anthropicCalls === (splitChild ? 1 : 2)) {
						return anthropicStream({
							issueType,
							reproducible: false,
							skipped: issueType !== 'Bug',
							skippedReason: issueType === 'Bug' ? null : 'not-actionable',
						});
					}
					return anthropicStream({
						result:
							'- **Reproduced:** No\n- **Exploration:** No\n- **Unit Test:** No\n- **Priority:** Priority P3: Minor bug.\n',
					});
				}

				if (url.endsWith('/issues/123') && init?.method === 'PATCH') {
					assert.equal(new Headers(init.headers).get('Authorization'), 'token write-token');
					const payload = JSON.parse(String(init.body));
					assert.deepEqual(Object.keys(payload), ['type']);
					issueTypes.push(payload.type);
					return jsonResponse({});
				}
				if (url.endsWith('/issues/123')) {
					return jsonResponse({
						title: 'Example issue',
						body: splitChild
							? '<!-- triagebot:split-from:100 -->\nSplit from #100.\n\nIssue body'
							: 'Issue body',
						user: { login: 'reporter' },
						labels: [{ name: 'triage: needs triage' }],
						created_at: '2026-01-01T00:00:00Z',
						state: 'open',
						number: 123,
						html_url: 'https://github.com/withastro/astro/issues/123',
					});
				}
				if (url.endsWith('/issues/123/comments?per_page=100')) return jsonResponse([]);
				if (url.endsWith('/labels?per_page=100&page=1')) {
					return jsonResponse([
						{ name: '- P3: minor bug', description: 'Minor bug' },
						{ name: 'pkg: astro', description: 'Core package' },
					]);
				}
				if (url.endsWith('/issues/123/comments') && init?.method === 'POST') {
					comments.push(JSON.parse(String(init.body)).body);
					return jsonResponse({ id: 42 });
				}
				if (url.includes('/issues/123/labels/') && init?.method === 'DELETE') {
					removedLabel = decodeURIComponent(url.split('/').at(-1) ?? '');
					return new Response('', { status: 200 });
				}
				if (url.endsWith('/issues/123/labels') && init?.method === 'POST') {
					addedLabels.push(JSON.parse(String(init.body)).labels);
					return jsonResponse([]);
				}
				throw new Error(`Unexpected fetch: ${url}`);
			};

			const ctx: ActionContext = {
				repo: 'withastro/astro',
				readToken: 'read-token',
				writeToken: 'write-token',
				anthropicApiKey: 'test-key',
				triageSkill,
				prSkill: null,
				prSkillName: 'astro-pr-writer',
				autoPrOnFix: false,
				buildCommand: null,
				triageModel: 'anthropic/claude-sonnet-4-6',
				verificationModel: 'anthropic/claude-sonnet-4-6',
				labels: labelConfigFromInputs(() => ''),
				botLogins: ['github-actions[bot]', 'astrobot-houston'],
			};

			await withTimeout(handleTriage(123, ctx), 10_000);

			assert.equal(anthropicCalls, splitChild ? 2 : 3);
			assert.equal(comments.length, 1);
			assert.match(comments[0], /Reproduced/);
			assert.equal(removedLabel, 'triage: needs triage');
			assert.deepEqual(issueTypes, [issueType]);
			assert.deepEqual(addedLabels, [
				[issueType === 'Bug' ? 'triage: unable to reproduce' : 'triage: not actionable'],
			]);
		});
	}

	for (const failSecondIssue of [false, true]) {
		it(
			failSecondIssue
				? 'leaves the parent open and does not repeat a partial split'
				: 'creates and links three independent lint issues before closing the parent',
			async () => {
				const triageSkill = setupRepo();
				process.env.ANTHROPIC_API_KEY = 'test-key';
				const followUps = [
					{
						title: 'array-type misses Readonly arrays',
						body: 'Given `Readonly<string[]>`, expected a diagnostic.',
					},
					{
						title: 'prefer-as-const misses angle-bracket assertions',
						body: 'Given `<"baz">"baz"`, expected a diagnostic.',
					},
					{
						title: 'explicit-function-return-type misses block-bodied arrows',
						body: 'Given a block-bodied arrow returned in a typed object, expected a diagnostic.',
					},
				];
				const requests: { method: string; path: string; payload: Record<string, unknown> }[] = [];
				let modelCalls = 0;
				let parentComment = '';
				let creationAttempts = 0;
				let state = 'open';
				globalThis.fetch = async (input, init) => {
					const url = String(input);
					if (url.startsWith('https://api.anthropic.com/')) {
						assert.equal(++modelCalls, 1);
						const { messages } = JSON.parse(String(init?.body));
						assert.match(
							JSON.stringify(messages),
							/array-type, prefer-as-const, explicit-function-return-type/,
						);
						return anthropicStream({ followUps });
					}
					const { pathname: path, searchParams } = new URL(url);
					const method = init?.method ?? 'GET';
					if (path.endsWith('/issues/123') && method === 'GET') {
						return jsonResponse({
							title: 'Linter misses three shapes',
							body: 'array-type, prefer-as-const, explicit-function-return-type',
							user: { login: 'reporter' },
							labels: [{ name: 'triage: needs triage' }],
							created_at: '2026-01-01T00:00:00Z',
							state,
							number: 123,
							html_url: 'https://github.com/withastro/astro/issues/123',
						});
					}
					if (path.endsWith('/issues/123/comments') && method === 'GET') {
						if (searchParams.get('page') === '2') {
							return jsonResponse([splitComment('astrobot-houston', parentComment)]);
						}
						const response = jsonResponse([
							splitComment('reporter', '<!-- triagebot:issue-split -->'),
						]);
						if (parentComment) response.headers.set('link', `<${url}&page=2>; rel="next"`);
						return response;
					}
					assert.equal(new Headers(init?.headers).get('authorization'), 'token write-token');
					const payload = JSON.parse(String(init?.body));
					requests.push({ method, path: path.replace('/repos/withastro/astro', ''), payload });
					if (path.endsWith('/issues/123/comments') && method === 'POST') {
						parentComment = payload.body;
						return jsonResponse({ id: 42 });
					}
					if (path.endsWith('/issues') && method === 'POST') {
						creationAttempts += 1;
						if (failSecondIssue && creationAttempts === 2) return new Response('', { status: 500 });
						return jsonResponse({ number: 123 + creationAttempts });
					}
					if (path.endsWith('/issues/comments/42') && method === 'PATCH') {
						parentComment = payload.body;
						return jsonResponse({});
					}
					if (path.endsWith('/issues/123') && method === 'PATCH') {
						state = payload.state;
						return jsonResponse({});
					}
					throw new Error(`Unexpected fetch: ${method} ${url}`);
				};
				const ctx: ActionContext = {
					repo: 'withastro/astro',
					readToken: 'read-token',
					writeToken: 'write-token',
					anthropicApiKey: 'test-key',
					triageSkill,
					prSkill: null,
					prSkillName: 'astro-pr-writer',
					autoPrOnFix: true,
					buildCommand: null,
					triageModel: 'anthropic/claude-sonnet-4-6',
					verificationModel: 'anthropic/claude-sonnet-4-6',
					labels: labelConfigFromInputs(() => ''),
					botLogins: ['github-actions[bot]', 'astrobot-houston'],
				};

				const result = withTimeout(handleTriage(123, ctx), 10_000);
				if (failSecondIssue) {
					await assert.rejects(result, /Failed to finish splitting issue #123/);
					assert.equal(state, 'open');
					assert.match(parentComment, /finish the split manually[\s\S]*- #124/);
				} else {
					await result;
					assert.equal(state, 'closed');
					assert.match(parentComment, /- #124\n- #125\n- #126/);
					assert.deepEqual(requests.at(-1)?.payload, {
						state: 'closed',
						state_reason: 'completed',
					});
				}

				const expectedChildren = failSecondIssue ? followUps.slice(0, 2) : followUps;
				assert.deepEqual(
					requests.filter(({ path }) => path === '/issues').map(({ payload }) => payload),
					expectedChildren.map(({ title, body }) => ({
						title,
						body: `<!-- triagebot:split-from:123 -->\nSplit from #123.\n\n${body}`,
					})),
				);
				assert.deepEqual(
					requests.map(({ method, path }) => `${method} ${path}`),
					[
						'POST /issues/123/comments',
						...expectedChildren.map(() => 'POST /issues'),
						'PATCH /issues/comments/42',
						...(failSecondIssue ? [] : ['PATCH /issues/123']),
					],
				);
				const writes = requests.length;
				await withTimeout(handleTriage(123, ctx), 10_000);
				await withTimeout(handleRetriage(123, ctx.labels.needsTriage, ctx), 10_000);
				await withTimeout(handleVerifyFix(123, ctx), 10_000);
				assert.equal(requests.length, writes);
				assert.equal(modelCalls, 1);
				assert.equal(
					spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).stdout.trim(),
					'main',
				);
			},
		);
	}

	it('publishes a preview release for fixed package changes before marking fix pending', async () => {
		const triageSkill = setupRepo();
		configureLocalPushRemote();
		installFakePnpm('https://pkg.pr.new/astro@test123');
		writeFileSync(
			join(tempDir as string, 'packages', 'astro', 'src', 'index.ts'),
			'export const value = 2;\n',
		);

		process.env.ANTHROPIC_API_KEY = 'test-key';
		const comments: string[] = [];
		const addedLabels: string[][] = [];
		const removedLabels: string[] = [];
		const issueTypes: string[] = [];
		let anthropicCalls = 0;
		let commentPromptIncludedPreviewUrl = false;

		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url.startsWith('https://api.anthropic.com/')) {
				anthropicCalls += 1;
				const body = JSON.parse(String(init?.body ?? '{}'));
				if (anthropicCalls === 1) return anthropicStream({ followUps: [] });
				if (anthropicCalls === 2) {
					return anthropicStream({
						issueType: 'Bug',
						reproducible: true,
						skipped: false,
						skippedReason: null,
					});
				}
				if (anthropicCalls === 3) return anthropicStream({ confidence: 'high' });
				if (anthropicCalls === 4) return anthropicStream({ verdict: 'bug', confidence: 'high' });
				if (anthropicCalls === 5) {
					return anthropicStream({ fixed: true, commitMessage: 'fix: update astro package' });
				}
				if (anthropicCalls === 6) {
					commentPromptIncludedPreviewUrl = JSON.stringify(body).includes(
						'https://pkg.pr.new/astro@test123',
					);
					return anthropicStream({
						result:
							'- **Reproduced:** Yes\n- **Exploration:** Yes\n- **Unit Test:** Yes\n- **Priority:** Priority P3: Minor bug.\n\n### Try this fix\n\nnpm i https://pkg.pr.new/astro@test123\n',
					});
				}
				if (anthropicCalls === 7) {
					return anthropicStream({ priority: '- P3: minor bug', packages: ['pkg: astro'] });
				}
				throw new Error('Too many mocked Anthropic calls');
			}

			if (url.endsWith('/issues/123') && init?.method === 'PATCH') {
				assert.equal(new Headers(init.headers).get('Authorization'), 'token write-token');
				const payload = JSON.parse(String(init.body));
				assert.deepEqual(Object.keys(payload), ['type']);
				issueTypes.push(payload.type);
				return jsonResponse({});
			}
			if (url.endsWith('/issues/123')) {
				return jsonResponse({
					title: 'Example issue',
					body: 'Issue body',
					user: { login: 'reporter' },
					labels: [{ name: 'triage: needs triage' }],
					created_at: '2026-01-01T00:00:00Z',
					state: 'open',
					number: 123,
					html_url: 'https://github.com/withastro/astro/issues/123',
				});
			}
			if (url.endsWith('/issues/123/comments?per_page=100')) return jsonResponse([]);
			if (url.endsWith('/labels?per_page=100&page=1')) {
				return jsonResponse([
					{ name: '- P3: minor bug', description: 'Minor bug' },
					{ name: 'pkg: astro', description: 'Core package' },
				]);
			}
			if (url.endsWith('/issues/123/comments') && init?.method === 'POST') {
				comments.push(JSON.parse(String(init.body)).body);
				return jsonResponse({ id: 42 });
			}
			if (url.includes('/issues/123/labels/') && init?.method === 'DELETE') {
				removedLabels.push(decodeURIComponent(url.split('/').at(-1) ?? ''));
				return new Response('', { status: 200 });
			}
			if (url.endsWith('/issues/123/labels') && init?.method === 'POST') {
				addedLabels.push(JSON.parse(String(init.body)).labels);
				return jsonResponse([]);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const ctx: ActionContext = {
			repo: 'withastro/astro',
			readToken: 'read-token',
			writeToken: 'write-token',
			anthropicApiKey: 'test-key',
			triageSkill,
			prSkill: null,
			prSkillName: 'astro-pr-writer',
			autoPrOnFix: false,
			buildCommand: null,
			triageModel: 'anthropic/claude-sonnet-4-6',
			verificationModel: 'anthropic/claude-sonnet-4-6',
			labels: labelConfigFromInputs(() => ''),
			botLogins: ['github-actions[bot]', 'astrobot-houston'],
		};

		await withTimeout(handleTriage(123, ctx), 20_000);

		assert.equal(anthropicCalls, 7);
		assert.equal(commentPromptIncludedPreviewUrl, true);
		assert.equal(comments.length, 1);
		assert.match(comments[0], /https:\/\/pkg\.pr\.new\/astro@test123/);
		assert.deepEqual(issueTypes, ['Bug']);
		assert.deepEqual(removedLabels, ['triage: needs triage']);
		assert.deepEqual(addedLabels, [['triage: fix pending'], ['- P3: minor bug', 'pkg: astro']]);
	});

	it('opens a pull request directly and marks fix verified when auto-pr-on-fix is enabled', async () => {
		const triageSkill = setupRepo();
		configureLocalPushRemote();
		writeFileSync(
			join(tempDir as string, 'packages', 'astro', 'src', 'index.ts'),
			'export const value = 2;\n',
		);

		process.env.ANTHROPIC_API_KEY = 'test-key';
		const comments: string[] = [];
		const addedLabels: string[][] = [];
		const prLabels: string[][] = [];
		const removedLabels: string[] = [];
		const issueTypes: string[] = [];
		let anthropicCalls = 0;
		let createdPrHead: string | null = null;
		let createdPrBase: string | null = null;

		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url.startsWith('https://api.anthropic.com/')) {
				anthropicCalls += 1;
				if (anthropicCalls === 1) return anthropicStream({ followUps: [] });
				if (anthropicCalls === 2) {
					return anthropicStream({
						issueType: 'Bug',
						reproducible: true,
						skipped: false,
						skippedReason: null,
					});
				}
				if (anthropicCalls === 3) return anthropicStream({ confidence: 'high' });
				if (anthropicCalls === 4) return anthropicStream({ verdict: 'bug', confidence: 'high' });
				if (anthropicCalls === 5) {
					return anthropicStream({ fixed: true, commitMessage: 'fix: update astro package' });
				}
				if (anthropicCalls === 6) {
					return anthropicStream({ title: 'Fix the astro package', body: 'Closes #123' });
				}
				if (anthropicCalls === 7) {
					return anthropicStream({
						result:
							'- **Reproduced:** Yes\n- **Exploration:** Yes\n- **Unit Test:** Yes\n- **Priority:** Priority P3: Minor bug.\n',
					});
				}
				if (anthropicCalls === 8) {
					return anthropicStream({ priority: '- P3: minor bug', packages: ['pkg: astro'] });
				}
				throw new Error('Too many mocked Anthropic calls');
			}

			if (url.endsWith('/issues/123') && init?.method === 'PATCH') {
				assert.equal(new Headers(init.headers).get('Authorization'), 'token write-token');
				const payload = JSON.parse(String(init.body));
				assert.deepEqual(Object.keys(payload), ['type']);
				issueTypes.push(payload.type);
				return jsonResponse({});
			}
			if (url.endsWith('/issues/123')) {
				return jsonResponse({
					title: 'Example issue',
					body: 'Issue body',
					user: { login: 'reporter' },
					labels: [{ name: 'triage: needs triage' }],
					created_at: '2026-01-01T00:00:00Z',
					state: 'open',
					number: 123,
					html_url: 'https://github.com/withastro/astro/issues/123',
				});
			}
			if (url.endsWith('/issues/123/comments?per_page=100')) return jsonResponse([]);
			if (url.includes('/pulls?head=withastro%3Atriagebot%2Ffix-123&state=open')) {
				return jsonResponse([]);
			}
			if (url.endsWith('/pulls') && init?.method === 'POST') {
				const payload = JSON.parse(String(init.body));
				createdPrHead = payload.head;
				createdPrBase = payload.base;
				return jsonResponse({
					number: 456,
					html_url: 'https://github.com/withastro/astro/pull/456',
				});
			}
			if (url.endsWith('/issues/456/labels') && init?.method === 'POST') {
				prLabels.push(JSON.parse(String(init.body)).labels);
				return jsonResponse([]);
			}
			if (url.endsWith('/labels?per_page=100&page=1')) {
				return jsonResponse([
					{ name: '- P3: minor bug', description: 'Minor bug' },
					{ name: 'pkg: astro', description: 'Core package' },
				]);
			}
			if (url.endsWith('/issues/123/comments') && init?.method === 'POST') {
				comments.push(JSON.parse(String(init.body)).body);
				return jsonResponse({ id: 42 });
			}
			if (url.includes('/issues/123/labels/') && init?.method === 'DELETE') {
				removedLabels.push(decodeURIComponent(url.split('/').at(-1) ?? ''));
				return new Response('', { status: 200 });
			}
			if (url.endsWith('/issues/123/labels') && init?.method === 'POST') {
				addedLabels.push(JSON.parse(String(init.body)).labels);
				return jsonResponse([]);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const ctx: ActionContext = {
			repo: 'withastro/astro',
			readToken: 'read-token',
			writeToken: 'write-token',
			anthropicApiKey: 'test-key',
			triageSkill,
			prSkill: null,
			prSkillName: 'astro-pr-writer',
			autoPrOnFix: true,
			buildCommand: null,
			triageModel: 'anthropic/claude-sonnet-4-6',
			verificationModel: 'anthropic/claude-sonnet-4-6',
			labels: labelConfigFromInputs(() => ''),
			botLogins: ['github-actions[bot]', 'astrobot-houston'],
		};

		await withTimeout(handleTriage(123, ctx), 20_000);

		// PR content generated, then comment, then label selection: 7 LLM calls.
		assert.equal(anthropicCalls, 8);
		// A PR was opened directly from the fix branch against main.
		assert.equal(createdPrHead, 'triagebot/fix-123');
		assert.equal(createdPrBase, 'main');
		// The PR got the fix-verified PR label.
		assert.deepEqual(prLabels, [['fix verified']]);
		// The issue moved straight to fix verified (no preview => not fix pending).
		assert.deepEqual(issueTypes, ['Bug']);
		assert.deepEqual(removedLabels, ['triage: needs triage']);
		assert.deepEqual(addedLabels, [['triage: fix verified'], ['- P3: minor bug', 'pkg: astro']]);
		// The reporter comment links the opened PR.
		assert.equal(comments.length, 1);
		assert.match(comments[0], /pull\/456/);
	});
});
