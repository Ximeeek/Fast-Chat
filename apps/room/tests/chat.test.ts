import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateUsername } from '../src/lib/chat/username.ts';

describe('Cosmetic Username Generation', () => {
	test('generates username matching adjective-noun-number format', () => {
		const pattern = /^[a-z]+-[a-z]+-\d{2}$/;
		for (let i = 0; i < 50; i++) {
			const username = generateUsername();
			assert.match(
				username,
				pattern,
				`Username "${username}" does not match required format <adjective>-<noun>-<number>`
			);
		}
	});

	test('generates 2-digit numbers between 10 and 99 inclusive', () => {
		for (let i = 0; i < 100; i++) {
			const username = generateUsername();
			const parts = username.split('-');
			assert.equal(parts.length, 3);
			const num = parseInt(parts[2], 10);
			assert.ok(num >= 10 && num <= 99, `Number ${num} out of expected [10, 99] bounds`);
		}
	});

	test('exhibits high entropy with distinct outputs across multiple calls', () => {
		const names = new Set<string>();
		const count = 100;
		for (let i = 0; i < count; i++) {
			names.add(generateUsername());
		}
		// With 34 adjectives * 28 nouns * 90 numbers = 85,680 combinations,
		// 100 samples should produce overwhelmingly unique names.
		assert.ok(
			names.size > 85,
			`Expected high entropy (>85 unique out of 100), received ${names.size}`
		);
	});
});
