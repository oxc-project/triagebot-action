/** Live coding/tool-use smoke test. Run only in trusted CI with inference keys. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeSimple, Type } from '@earendil-works/pi-ai';
import { createModelResolver } from '../src/models.ts';

async function main() {
	const name = process.env.MODEL;
	assert.ok(name, 'MODEL is required');
	const apiKey = process.env.CLOUDFLARE_API_KEY;
	assert.ok(apiKey, 'CLOUDFLARE_API_KEY is required');
	const resolve = createModelResolver(
		process.env.MODEL_CONFIG || '{}',
		process.env.CLOUDFLARE_ACCOUNT_ID,
		apiKey,
	);
	const model = resolve(name);
	assert.ok(model);
	const user = {
		role: 'user' as const,
		timestamp: Date.now(),
		content: `Fix this Rust function to support negative indices counting backwards from the end. Return None for an empty sequence or an index outside its bounds. Handle every i64 index and every u32 length without overflow. Keep the signature. Call submit_fix exactly once with the complete function source, without Markdown. After the tool result, reply exactly VERIFIED if tests passed, otherwise FAILED. Do not call more tools.

fn normalize_index(index: i64, len: u32) -> Option<u32> {
    Some(index as u32 % len)
}`,
	};
	const tools = [
		{
			name: 'submit_fix',
			description: 'Submit corrected Rust source for compilation and tests.',
			parameters: Type.Object({ source: Type.String() }),
		},
	];
	const options = {
		apiKey,
		maxTokens: 4096,
		reasoning: 'high' as const,
		timeoutMs: 90_000,
		maxRetries: 0,
	};
	const first = await completeSimple(model, { messages: [user], tools }, options);
	assert.equal(first.stopReason, 'toolUse', first.errorMessage);
	const calls = first.content.filter((part) => part.type === 'toolCall');
	assert.equal(calls.length, 1, 'Expected one streamed tool call');
	const call = calls[0];
	assert.equal(call.name, 'submit_fix');
	const source = call.arguments.source;
	assert.equal(typeof source, 'string');
	assert.ok(source.includes('fn normalize_index(index: i64, len: u32) -> Option<u32>'));
	const directory = mkdtempSync(join(tmpdir(), 'triage-model-'));
	try {
		const path = join(directory, 'test.rs');
		writeFileSync(
			path,
			`${source}
#[test]
fn index_bounds() {
    for len in [0_u32, 1, 2, 17, u32::MAX] {
        for index in [i64::MIN, -4294967296, -18, -17, -2, -1, 0, 1, 16, 17, 4294967294, 4294967295, i64::MAX] {
            let position = if index < 0 { i128::from(len) + i128::from(index) } else { i128::from(index) };
            let expected = if position >= 0 && position < i128::from(len) { Some(position as u32) } else { None };
            assert_eq!(normalize_index(index, len), expected, "index={index}, len={len}");
        }
    }
}
`,
		);
		// Generated code and the compiler receive no inference or GitHub credentials.
		const env = Object.fromEntries(
			['PATH', 'HOME', 'RUSTUP_HOME', 'CARGO_HOME'].flatMap((key) =>
				process.env[key] ? [[key, process.env[key]]] : [],
			),
		);
		for (const flags of [[], ['-O']]) {
			const binary = join(directory, 'test');
			execFileSync('rustc', ['--edition=2024', '--test', path, '-o', binary, ...flags], {
				cwd: directory,
				env,
				timeout: 30_000,
				stdio: 'pipe',
			});
			execFileSync(binary, [], { cwd: directory, env, timeout: 10_000, stdio: 'pipe' });
		}
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
						content: [
							{
								type: 'text',
								text: 'All 65 index/length boundary cases passed in both debug and optimized Rust builds.',
							},
						],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools,
			},
			options,
		);
		assert.equal(reply.stopReason, 'stop', reply.errorMessage);
		const text = reply.content
			.filter((part) => part.type === 'text')
			.map((part) => part.text)
			.join('')
			.trim();
		assert.equal(text, 'VERIFIED');
		console.info(
			JSON.stringify({
				model: name,
				passed: true,
				checks: ['streamed tool call', 'Rust debug', 'Rust optimized', 'tool-result round trip'],
			}),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

main().catch((error) => {
	let message = error instanceof Error ? error.message : String(error);
	for (const key of ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID']) {
		const value = process.env[key];
		if (value) message = message.replaceAll(value, '[redacted]');
	}
	console.error(message);
	process.exitCode = 1;
});
