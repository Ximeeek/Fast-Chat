import type { SupportedLanguage } from './languageDetection.ts';

let prismInstance: any = null;
const loadedGrammars = new Set<string>();

/**
 * Explicit static dynamic import map ensuring Vite produces isolated, lazy-loaded
 * chunk artifacts for Prism core and each supported grammar.
 */
const GRAMMAR_LOADERS: Record<string, () => Promise<unknown>> = {
	clike: () => import('prismjs/components/prism-clike.js'),
	javascript: () => import('prismjs/components/prism-javascript.js'),
	typescript: () => import('prismjs/components/prism-typescript.js'),
	python: () => import('prismjs/components/prism-python.js'),
	rust: () => import('prismjs/components/prism-rust.js'),
	c: () => import('prismjs/components/prism-c.js'),
	cpp: () => import('prismjs/components/prism-cpp.js'),
	csharp: () => import('prismjs/components/prism-csharp.js'),
	go: () => import('prismjs/components/prism-go.js'),
	java: () => import('prismjs/components/prism-java.js'),
	markup: () => import('prismjs/components/prism-markup.js'),
	css: () => import('prismjs/components/prism-css.js'),
	json: () => import('prismjs/components/prism-json.js'),
	sql: () => import('prismjs/components/prism-sql.js'),
	bash: () => import('prismjs/components/prism-bash.js'),
	'markup-templating': () => import('prismjs/components/prism-markup-templating.js'),
	php: () => import('prismjs/components/prism-php.js')
};

/**
 * Ordered grammar dependencies required by Prism.js component architecture.
 */
const LANGUAGE_DEPENDENCIES: Record<string, string[]> = {
	javascript: ['clike', 'javascript'],
	typescript: ['clike', 'javascript', 'typescript'],
	c: ['clike', 'c'],
	cpp: ['clike', 'c', 'cpp'],
	csharp: ['clike', 'csharp'],
	go: ['clike', 'go'],
	java: ['clike', 'java'],
	python: ['python'],
	rust: ['rust'],
	html: ['markup'],
	css: ['css'],
	json: ['json'],
	sql: ['sql'],
	bash: ['bash'],
	php: ['markup', 'markup-templating', 'php']
};

/**
 * Maps application language identifiers to Prism grammar dictionary keys.
 */
const GRAMMAR_KEY_MAP: Record<string, string> = {
	html: 'markup'
};

/**
 * Escapes HTML characters to prevent XSS injection in raw or fallback code rendering.
 *
 * @param str - Plaintext string.
 * @returns Sanitized HTML string.
 */
export function escapeHtml(str: string): string {
	if (!str) return '';
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * Lazily loads Prism core and all intermediate grammar dependencies for a requested language.
 *
 * @param language - Target language identifier.
 * @returns Resolves true if grammar is loaded and ready, false if unsupported or failed.
 */
export async function loadLanguageGrammar(language: string): Promise<boolean> {
	const normalized = language.toLowerCase();
	const chain = LANGUAGE_DEPENDENCIES[normalized];
	if (!chain) return false;

	try {
		if (!prismInstance) {
			const core = await import('prismjs/components/prism-core.js');
			prismInstance = core.default || core;
		}

		for (const component of chain) {
			if (!loadedGrammars.has(component)) {
				const loader = GRAMMAR_LOADERS[component];
				if (loader) {
					await loader();
					loadedGrammars.add(component);
				}
			}
		}

		return true;
	} catch (err) {
		if (import.meta.env.DEV) {
			console.error(`Failed to load grammar for language ${language}:`, err);
		}
		return false;
	}
}

/**
 * Renders source code with syntax highlighting using on-demand Prism.js grammars.
 *
 * Falls back to clean, HTML-escaped monospace plaintext if the language is omitted,
 * unrecognized, or fails to load.
 *
 * @param code - Raw source code.
 * @param language - Optional language identifier.
 * @returns Sanitized HTML snippet with Prism syntax tokens or escaped plaintext.
 */
export async function highlightCode(
	code: string,
	language?: string | null
): Promise<string> {
	if (!code) return '';

	if (!language) {
		return escapeHtml(code);
	}

	const normalized = language.toLowerCase().trim();
	const isLoaded = await loadLanguageGrammar(normalized);

	if (isLoaded && prismInstance?.languages) {
		const grammarKey = GRAMMAR_KEY_MAP[normalized] || normalized;
		const grammar = prismInstance.languages[grammarKey];
		if (grammar) {
			try {
				return prismInstance.highlight(code, grammar, grammarKey);
			} catch (err) {
				if (import.meta.env.DEV) {
					console.error(`Failed to highlight code with grammar ${grammarKey}:`, err);
				}
			}
		}
	}

	return escapeHtml(code);
}
