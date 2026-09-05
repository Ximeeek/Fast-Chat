/**
 * Curated list of friendly, distinct adjectives for cosmetic nickname generation.
 */
const ADJECTIVES: readonly string[] = [
	'agile',
	'amber',
	'bold',
	'brave',
	'bright',
	'calm',
	'clever',
	'cosmic',
	'crisp',
	'eager',
	'frosty',
	'gentle',
	'golden',
	'hardy',
	'keen',
	'lucid',
	'lunar',
	'mystic',
	'nimble',
	'noble',
	'proud',
	'quick',
	'quiet',
	'radiant',
	'rapid',
	'silent',
	'silver',
	'solar',
	'stellar',
	'subtle',
	'swift',
	'vivid',
	'warm',
	'wild'
];

/**
 * Curated list of animals and nature nouns for cosmetic nickname generation.
 */
const NOUNS: readonly string[] = [
	'badger',
	'bear',
	'cedar',
	'cheetah',
	'crane',
	'deer',
	'dolphin',
	'eagle',
	'falcon',
	'finch',
	'fox',
	'hawk',
	'heron',
	'koala',
	'leopard',
	'lynx',
	'otter',
	'owl',
	'panda',
	'panther',
	'quail',
	'raven',
	'robin',
	'seal',
	'sparrow',
	'tiger',
	'walrus',
	'wolf'
];

/**
 * Returns a cryptographically random unsigned integer in the range [0, maxExclusive).
 */
function getRandomInt(maxExclusive: number): number {
	if (maxExclusive <= 0) return 0;
	const buffer = new Uint32Array(1);
	crypto.getRandomValues(buffer);
	return buffer[0] % maxExclusive;
}

/**
 * Generates a random cosmetic username formatted as `<adjective>-<noun>-<number>` (e.g., `swift-fox-42`).
 *
 * This identifier is generated purely client-side once upon room entry and is strictly cosmetic.
 * It is never persisted to disk or browser storage and conveys no authentication, identity,
 * or account privileges.
 *
 * @returns A formatted cosmetic username string.
 */
export function generateUsername(): string {
	const adj = ADJECTIVES[getRandomInt(ADJECTIVES.length)];
	const noun = NOUNS[getRandomInt(NOUNS.length)];
	const num = getRandomInt(90) + 10; // Uniform 2-digit number in [10, 99]
	return `${adj}-${noun}-${num}`;
}
