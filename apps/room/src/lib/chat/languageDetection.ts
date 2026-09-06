/**
 * List of languages supported by the heuristic detector and syntax highlighting pipeline.
 */
export type SupportedLanguage =
	| 'javascript'
	| 'typescript'
	| 'python'
	| 'rust'
	| 'go'
	| 'java'
	| 'c'
	| 'cpp'
	| 'csharp'
	| 'html'
	| 'css'
	| 'json'
	| 'sql'
	| 'bash'
	| 'php';

/**
 * Descriptive metadata for a supported language.
 */
export interface LanguageMeta {
	id: SupportedLanguage;
	name: string;
	prismGrammar: string;
}

export const SUPPORTED_LANGUAGES: readonly LanguageMeta[] = [
	{ id: 'javascript', name: 'JavaScript', prismGrammar: 'javascript' },
	{ id: 'typescript', name: 'TypeScript', prismGrammar: 'typescript' },
	{ id: 'python', name: 'Python', prismGrammar: 'python' },
	{ id: 'rust', name: 'Rust', prismGrammar: 'rust' },
	{ id: 'go', name: 'Go', prismGrammar: 'go' },
	{ id: 'java', name: 'Java', prismGrammar: 'java' },
	{ id: 'c', name: 'C', prismGrammar: 'c' },
	{ id: 'cpp', name: 'C++', prismGrammar: 'cpp' },
	{ id: 'csharp', name: 'C#', prismGrammar: 'csharp' },
	{ id: 'html', name: 'HTML', prismGrammar: 'markup' },
	{ id: 'css', name: 'CSS', prismGrammar: 'css' },
	{ id: 'json', name: 'JSON', prismGrammar: 'json' },
	{ id: 'sql', name: 'SQL', prismGrammar: 'sql' },
	{ id: 'bash', name: 'Bash', prismGrammar: 'bash' },
	{ id: 'php', name: 'PHP', prismGrammar: 'php' }
] as const;

/**
 * Returns human-friendly display label for a supported language or fallback.
 */
export function getLanguageDisplayName(lang: string | null | undefined): string {
	if (!lang) return 'Code';
	const found = SUPPORTED_LANGUAGES.find((l) => l.id.toLowerCase() === lang.toLowerCase());
	return found ? found.name : lang.toUpperCase();
}

/**
 * Heuristically determines the programming or markup language of a given code snippet.
 * Executed only when a message has been designated as code (automatically or manually).
 *
 * Employs characteristic token matching and score accumulation without heavy ML models.
 *
 * @param code - Raw source code string.
 * @returns Detected SupportedLanguage identifier, or null if ambiguous.
 */
export function detectLanguage(code: string): SupportedLanguage | null {
	if (!code || typeof code !== 'string') return null;
	const trimmed = code.trim();
	if (trimmed.length === 0) return null;

	// 1. JSON early check: structurally enclosed objects/arrays with key-value pairs
	if (
		(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
		(trimmed.startsWith('[') && trimmed.endsWith(']'))
	) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed !== null && typeof parsed === 'object') {
				// Require key-value pair pattern or array of objects/primitives
				if (/"[^"]+"\s*:/.test(trimmed) || (Array.isArray(parsed) && parsed.length > 0)) {
					return 'json';
				}
			}
		} catch {
			// Not valid JSON
		}
	}

	// 2. HTML early check: doctype or html tag
	if (/<!doctype\s+html/i.test(trimmed) || /<html\b[^>]*>/i.test(trimmed)) {
		return 'html';
	}

	// 3. PHP early check: <?php tag
	if (/<\?(?:php|=)/i.test(trimmed)) {
		return 'php';
	}

	// 4. Bash early check: shebang
	if (/^#!\/bin\/(?:bash|sh|zsh)/m.test(trimmed)) {
		return 'bash';
	}

	// Language score table
	const scores: Record<SupportedLanguage, number> = {
		javascript: 0,
		typescript: 0,
		python: 0,
		rust: 0,
		go: 0,
		java: 0,
		c: 0,
		cpp: 0,
		csharp: 0,
		html: 0,
		css: 0,
		json: 0,
		sql: 0,
		bash: 0,
		php: 0
	};

	// --- PYTHON ---
	if (/\bdef\s+[a-zA-Z_]\w*\s*\([^)]*\)\s*:/m.test(trimmed)) scores.python += 6;
	if (/\belif\b/.test(trimmed)) scores.python += 5;
	if (/\bself\.[a-zA-Z_]\w*/.test(trimmed)) scores.python += 4;
	if (/\b__init__\b/.test(trimmed)) scores.python += 5;
	if (/\bprint\s*\(/.test(trimmed)) scores.python += 3;
	if (/\bfrom\s+[a-zA-Z0-9_.]+\s+import\b/.test(trimmed)) scores.python += 5;
	if (/\bimport\s+[a-zA-Z0-9_.]+(?:\s+as\s+[a-zA-Z0-9_]+)?$/m.test(trimmed)) scores.python += 3;
	if (/\b(?:None|True|False)\b/.test(trimmed) && !scores.python) scores.python += 2;

	// --- RUST ---
	if (/\bfn\s+[a-zA-Z_]\w*\s*\([^)]*\)/.test(trimmed)) scores.rust += 5;
	if (/\blet\s+mut\s+/.test(trimmed)) scores.rust += 6;
	if (/\bimpl(?:\s+[a-zA-Z_]\w*)?\s+for\s+/.test(trimmed) || /\bimpl\s+[a-zA-Z_]\w*\s*\{/.test(trimmed)) scores.rust += 6;
	if (/\bpub(?:\([^)]*\))?\s+(?:fn|struct|enum|trait|mod)\b/.test(trimmed)) scores.rust += 5;
	if (/\bprintln!\s*\(/.test(trimmed) || /\bvec!\s*\[/.test(trimmed)) scores.rust += 6;
	if (/->\s*(?:Result|Option|<|&|[A-Z]\w*)/.test(trimmed) && /fn\s+/.test(trimmed)) scores.rust += 4;
	if (/\bmatch\s+[a-zA-Z0-9_.*&]+\s*\{/.test(trimmed)) scores.rust += 4;
	if (/\b(?:i32|i64|u32|u64|usize|isize|String::from|&str)\b/.test(trimmed)) scores.rust += 4;

	// --- GO ---
	if (/\bpackage\s+[a-zA-Z_]\w*/m.test(trimmed)) scores.go += 6;
	if (/\bfunc\s+(?:\([^)]+\)\s+)?[a-zA-Z_]\w*\s*\([^)]*\)/m.test(trimmed)) scores.go += 5;
	if (/fmt\.(?:Println|Printf|Sprintf|Print)\s*\(/.test(trimmed)) scores.go += 6;
	if (/:=\s*/.test(trimmed)) scores.go += 4;
	if (/\bgo\s+func\s*\(/.test(trimmed)) scores.go += 6;
	if (/\bchan\s+[a-zA-Z_]/.test(trimmed)) scores.go += 5;
	if (/\bdefer\s+[a-zA-Z_]/.test(trimmed)) scores.go += 4;

	// --- JAVA ---
	if (/public\s+(?:static\s+)?(?:final\s+)?class\s+[A-Z]\w*/.test(trimmed)) scores.java += 6;
	if (/System\.out\.print(?:ln)?\s*\(/.test(trimmed)) scores.java += 7;
	if (/public\s+static\s+void\s+main\s*\(/.test(trimmed)) scores.java += 8;
	if (/@Override\b/.test(trimmed)) scores.java += 5;
	if (/\bpackage\s+[a-z0-9_.]+\s*;/m.test(trimmed)) scores.java += 4;

	// --- C / C++ ---
	if (/#include\s*<stdio\.h>/i.test(trimmed)) {
		scores.c += 7;
	}
	if (/#include\s*<(?:iostream|vector|string|memory|algorithm|map|set)>/i.test(trimmed)) {
		scores.cpp += 7;
	}
	if (/\bstd::(?:cout|cin|endl|vector|string|make_shared|make_unique)\b/.test(trimmed)) {
		scores.cpp += 6;
	}
	if (/\bcout\s*<<\s*/.test(trimmed)) {
		scores.cpp += 6;
	}
	if (/\bprintf\s*\(\s*["']/.test(trimmed)) {
		scores.c += 4;
	}
	if (/\bmalloc\s*\(/.test(trimmed)) {
		scores.c += 4;
	}
	if (/\bnamespace\s+[a-zA-Z_]\w*\s*\{/.test(trimmed)) {
		scores.cpp += 5;
		scores.csharp += 3;
	}
	if (/\btemplate\s*<[^>]+>/.test(trimmed)) {
		scores.cpp += 5;
	}

	// --- C# ---
	if (/using\s+System(?:\.[a-zA-Z0-9_]+)?\s*;/m.test(trimmed)) scores.csharp += 7;
	if (/Console\.WriteLine\s*\(/.test(trimmed)) scores.csharp += 7;
	if (/\bget;\s*set;\b/.test(trimmed)) scores.csharp += 6;
	if (/\basync\s+Task(?:<[^>]+>)?\s+/.test(trimmed)) scores.csharp += 5;

	// --- HTML ---
	if (/<\/?(?:div|span|p|a|ul|ol|li|table|tr|td|button|input|form|section|header|footer|nav|article|h[1-6])\b[^>]*>/i.test(trimmed)) {
		scores.html += 5;
	}
	if (trimmed.includes('</') && trimmed.includes('>')) {
		scores.html += 3;
	}

	// --- CSS ---
	const cssPropMatches = trimmed.match(/(?:display|margin|padding|background|color|font-family|font-size|border|width|height|position|align-items|justify-content)\s*:[^;]+;/gi);
	if (cssPropMatches && cssPropMatches.length > 0) {
		scores.css += Math.min(cssPropMatches.length * 2.5, 8);
	}
	if (/@[a-z-]+\s*\{/i.test(trimmed)) scores.css += 4;
	if (/\{[^}]*\}/.test(trimmed) && /\b(?:px|rem|em|vh|vw|%)\b/.test(trimmed)) scores.css += 3;

	// --- SQL ---
	const sqlKeywords = trimmed.match(/\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY)\b/gi);
	if (sqlKeywords && sqlKeywords.length >= 2) {
		scores.sql += Math.min(sqlKeywords.length * 3, 9);
	}

	// --- BASH ---
	if (/^(?:npm|pnpm|yarn|bun|cargo|git|docker|kubectl|curl|wget|chmod|chown|sudo)\s+[a-z0-9_-]+/im.test(trimmed)) {
		scores.bash += 5;
	}
	if (/\b(?:echo\s+["']|chmod\s+\+x|sudo\s+apt)/.test(trimmed)) {
		scores.bash += 5;
	}

	// --- PHP ---
	if (/\$_GET|\$_POST|\$_SERVER|\$_SESSION/.test(trimmed)) scores.php += 6;
	if (/\$[a-zA-Z_]\w*\s*=\s*/.test(trimmed) && scores.bash === 0) scores.php += 3;

	// --- JAVASCRIPT / TYPESCRIPT ---
	if (/\bconsole\.log\s*\(/.test(trimmed)) {
		scores.javascript += 4;
		scores.typescript += 4;
	}
	if (/\b(?:const|let|var)\s+[a-zA-Z_$]\w*\s*=/m.test(trimmed)) {
		scores.javascript += 3;
		scores.typescript += 3;
	}
	if (/=>\s*\{?/.test(trimmed)) {
		scores.javascript += 2;
		scores.typescript += 2;
	}
	if (/\bexport\s+(?:default\s+)?(?:function|class|const|let)\b/.test(trimmed)) {
		scores.javascript += 3;
		scores.typescript += 3;
	}
	if (/\bimport\s+.*?\s+from\s+['"][^'"]+['"]/.test(trimmed)) {
		scores.javascript += 3;
		scores.typescript += 3;
	}

	// TypeScript discriminator
	let tsSpecificScore = 0;
	if (/\binterface\s+[A-Z]\w*/.test(trimmed)) tsSpecificScore += 5;
	if (/\btype\s+[A-Z]\w*\s*=/.test(trimmed)) tsSpecificScore += 5;
	if (/:\s*(?:string|number|boolean|any|void|unknown|never|Record<|Array<)[,);=>\s]/.test(trimmed)) tsSpecificScore += 4;
	if (/\bas\s+const\b/.test(trimmed)) tsSpecificScore += 4;
	if (/\benum\s+[A-Z]\w*/.test(trimmed)) tsSpecificScore += 5;
	scores.typescript += tsSpecificScore;

	// Find top language
	let bestLang: SupportedLanguage | null = null;
	let highestScore = 0;

	for (const [lang, score] of Object.entries(scores) as [SupportedLanguage, number][]) {
		if (score > highestScore) {
			highestScore = score;
			bestLang = lang;
		}
	}

	// Threshold: highest score must be at least 3 to make a confident identification
	if (highestScore < 3 || !bestLang) {
		return null;
	}

	// If TS and JS both scored, only pick TS if TS-specific score was earned
	if (bestLang === 'typescript' && tsSpecificScore === 0) {
		return 'javascript';
	}

	return bestLang;
}
