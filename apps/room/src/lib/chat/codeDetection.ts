/**
 * Set of structural keywords frequently present in source code across supported languages.
 */
const CODE_KEYWORDS = new Set([
	'abstract', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
	'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
	'finally', 'fn', 'for', 'from', 'func', 'function', 'if', 'implements', 'import', 'in',
	'instanceof', 'interface', 'let', 'match', 'mut', 'new', 'null', 'package', 'private',
	'protected', 'pub', 'public', 'readonly', 'return', 'static', 'struct', 'super', 'switch',
	'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'use', 'val', 'var',
	'void', 'while', 'yield',
	// Python & Go & Rust specifics
	'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'self', 'defer', 'chan', 'select', 'impl',
	// SQL keywords
	'select', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'table', 'where', 'join',
	// C / C++ / Java / C#
	'include', 'int', 'float', 'double', 'char', 'bool', 'boolean', 'namespace', 'cout', 'printf'
]);

/**
 * Common HTML/XML opening, closing, or self-closing tags.
 */
const HTML_TAG_PATTERN = /<\/?(?:html|head|body|div|span|p|a|ul|ol|li|table|tr|td|th|button|input|form|section|header|footer|nav|article|script|style|pre|code|svg|path|h[1-6])(?:\s+[^>]*?)?\/?>/i;

/**
 * Shell command signatures at the beginning of a line.
 */
const SHELL_PREFIX_PATTERN = /^(?:#!\/bin\/(?:bash|sh|zsh)|(?:npm|pnpm|yarn|bun|cargo|git|docker|kubectl|curl|wget|chmod|chown|sudo)\s+[a-z0-9_-]+)/im;

/**
 * Common code operators and multi-character delimiters.
 */
const CODE_OPERATORS = [
	'===', '!==', '==', '!=', '=>', '->', '::', '&&', '||', '++', '--',
	'+=', '-=', '*=', '/=', '&=', '|=', '<=', '>=', '<<', '>>', ':=', '<?php'
];

/**
 * Evaluates whether a given plaintext string exhibits structural and lexical characteristics
 * typical of source code, scripts, configuration formats, or markup languages.
 *
 * Designed as a lightweight, zero-dependency pre-flight heuristic executed on outgoing
 * and incoming chat messages to automatically flag code snippets without false-positiving
 * standard conversational prose.
 *
 * @param text - The raw plaintext string to inspect.
 * @returns True if the heuristic score exceeds the code detection threshold.
 */
export function isCodeSnippet(text: string): boolean {
	if (!text || typeof text !== 'string') return false;

	const trimmed = text.trim();
	if (trimmed.length === 0) return false;

	// Immediate match for explicit shell scripts or shebangs
	if (SHELL_PREFIX_PATTERN.test(trimmed)) {
		return true;
	}

	// Immediate match for HTML/XML markup structures
	if (HTML_TAG_PATTERN.test(trimmed) && (trimmed.includes('</') || trimmed.includes('/>') || trimmed.startsWith('<'))) {
		return true;
	}

	// Immediate match for valid non-primitive JSON structures
	if (
		(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
		(trimmed.startsWith('[') && trimmed.endsWith(']'))
	) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed !== null && typeof parsed === 'object') {
				return true;
			}
		} catch {
			// Not valid JSON, continue to scoring heuristic
		}
	}

	const lines = trimmed.split(/\r\n|\r|\n/);
	const lineCount = lines.length;

	let score = 0;

	// 1. Indentation consistency (indentation with 2+ spaces or tabs on non-empty lines)
	let indentedLines = 0;
	let nonEmptyLines = 0;
	for (const line of lines) {
		if (line.trim().length > 0) {
			nonEmptyLines++;
			if (/^(?: {2,}|\t)/.test(line)) {
				indentedLines++;
			}
		}
	}
	if (nonEmptyLines >= 2 && indentedLines >= 1) {
		const indentRatio = indentedLines / nonEmptyLines;
		if (indentRatio >= 0.3) {
			score += 3;
		}
	}

	// 2. Trailing semicolons and braces at line ends
	let statementTerminators = 0;
	for (const line of lines) {
		const lineTrimmed = line.trim();
		if (/[;{}]$/.test(lineTrimmed)) {
			statementTerminators++;
		}
	}
	if (statementTerminators >= 1) {
		score += Math.min(statementTerminators * 1.5, 6);
	}

	// 3. Braces and bracket balance / pairs
	const openBraces = (trimmed.match(/{/g) || []).length;
	const closeBraces = (trimmed.match(/}/g) || []).length;
	if (openBraces > 0 && openBraces === closeBraces) {
		score += 3;
	} else if (openBraces > 0 || closeBraces > 0) {
		score += 1;
	}

	const openBrackets = (trimmed.match(/\[/g) || []).length;
	const closeBrackets = (trimmed.match(/\]/g) || []).length;
	if (openBrackets > 0 && openBrackets === closeBrackets) {
		score += 1.5;
	}

	const openParens = (trimmed.match(/\(/g) || []).length;
	const closeParens = (trimmed.match(/\)/g) || []).length;
	if (openParens > 0 && openParens === closeParens) {
		// Parentheses alone are common in prose (like this), so smaller weight unless paired with keywords/calls
		score += 0.5;
	}

	// Function call or method invocation pattern: e.g. identifier(args)
	const functionCallMatches = trimmed.match(/[a-zA-Z_$][a-zA-Z0-9_$]*\s*\([^)]*\)/g);
	if (functionCallMatches && functionCallMatches.length > 0) {
		score += Math.min(functionCallMatches.length * 1.5, 4.5);
	}

	// 4. Code operators
	for (const op of CODE_OPERATORS) {
		if (trimmed.includes(op)) {
			score += 2;
		}
	}

	// 5. Code keywords
	const tokens = trimmed.toLowerCase().match(/\b[a-z_][a-z0-9_]*\b/g) || [];
	let keywordHits = 0;
	for (const token of tokens) {
		if (CODE_KEYWORDS.has(token)) {
			keywordHits++;
		}
	}
	if (keywordHits >= 1) {
		score += Math.min(keywordHits * 1.5, 6);
	}

	// 6. Identifier casing (camelCase, snake_case, UPPER_CASE with underscores)
	const specialCaseMatches = trimmed.match(/\b(?:[a-z]+[A-Z][a-zA-Z0-9]*|[a-z0-9]+_[a-z0-9_]+|[A-Z0-9]+_[A-Z0-9_]+)\b/g) || [];
	if (specialCaseMatches.length > 0) {
		score += Math.min(specialCaseMatches.length * 1, 3);
	}

	// 7. Conversational prose penalty
	// Prose sentences typically end with punctuation followed by space and uppercase letter
	const sentenceCount = (trimmed.match(/[.!?]\s+[A-Z]/g) || []).length;
	if (sentenceCount >= 1 && keywordHits === 0 && openBraces === 0) {
		score -= sentenceCount * 2.5;
	}

	// Natural language question or conversational greeting without code markers
	if (
		/^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|please|ok|okay|cześć|siema|hej|dzień\s+dobry)\b/i.test(trimmed) &&
		openBraces === 0 &&
		statementTerminators === 0
	) {
		score -= 4;
	}

	// Overall code syntax density: ratio of code characters to non-whitespace length
	const codeCharsCount = (trimmed.match(/[{}()[\];=<>&|!~:+\-*/%^]/g) || []).length;
	const nonWsLength = trimmed.replace(/\s/g, '').length;
	if (nonWsLength > 0) {
		const density = codeCharsCount / nonWsLength;
		if (density >= 0.15) {
			score += 3;
		} else if (density <= 0.02 && lineCount <= 2) {
			score -= 2;
		}
	}

	// Threshold: score >= 4 represents confident code indicators
	return score >= 4;
}
