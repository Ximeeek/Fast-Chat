import { getLanguageDisplayName } from './languageDetection.ts';

/**
 * Representation of a multi-line or long pasted text snippet
 * attached to the client-side chat drafting input before transmission.
 */
export interface PastedBlock {
	/** Unique local snippet identifier */
	id: string;
	/** Raw text contents of the pasted snippet */
	content: string;
	/** Number of lines detected in the snippet */
	lineCount: number;
	/** Whether the snippet is currently expanded to show full text in the input */
	isExpanded: boolean;
	/** Content classification: standard text or source code */
	contentType?: 'text' | 'code';
	/** Detected or manually selected programming language */
	language?: string | null;
}

/**
 * Counts the total number of lines in a text string across CRLF, LF, and CR line breaks.
 *
 * @param text - Input string to measure.
 * @returns Number of lines (minimum 1 for non-empty text, 0 for empty text).
 */
export function countLines(text: string): number {
	if (!text) return 0;
	return text.split(/\r\n|\r|\n/).length;
}

/**
 * Determines whether a pasted text snippet exceeds normal single-line chat input thresholds.
 *
 * @param text - The raw pasted text from clipboard.
 * @param lineThreshold - Minimum lines to trigger snippet containment (default: 3).
 * @param charThreshold - Minimum characters to trigger snippet containment (default: 250).
 * @returns True if the pasted text should be handled as a collapsible snippet block.
 */
export function isLongPastedText(text: string, lineThreshold = 3, charThreshold = 250): boolean {
	if (!text) return false;
	const lines = countLines(text);
	return lines >= lineThreshold || text.length > charThreshold;
}

/**
 * Formats the user-facing collapsed snippet label, optionally presenting the detected language.
 *
 * @param lineCount - Number of lines in the snippet.
 * @param language - Optional detected language identifier.
 * @param isCode - Whether the snippet is designated as source code.
 * @returns Formatted label string, e.g. "[ Pasted 12 Lines of Text ]" or "[ Pasted 47 Lines · JavaScript ]".
 */
export function formatPastedLabel(
	lineCount: number,
	language?: string | null,
	isCode?: boolean
): string {
	const count = Math.max(lineCount, 1);
	const unit = count === 1 ? 'Line' : 'Lines';
	if (isCode || language) {
		const langDisplay = getLanguageDisplayName(language);
		return `[ Pasted ${count} ${unit} · ${langDisplay} ]`;
	}
	return `[ Pasted ${count} ${unit} of Text ]`;
}

/**
 * Combines typed companion input text and any attached pasted snippet blocks
 * into the complete message body ready for encryption and broadcast.
 *
 * @param inputText - Direct text typed into the input field.
 * @param blocks - Attached pasted snippet blocks.
 * @returns Combined plaintext string.
 */
export function composeFinalMessage(inputText: string, blocks: PastedBlock[]): string {
	const parts: string[] = [];
	const trimmedInput = inputText.trim();
	if (trimmedInput) {
		parts.push(trimmedInput);
	}
	for (const block of blocks) {
		const trimmedContent = block.content.trim();
		if (trimmedContent) {
			parts.push(trimmedContent);
		}
	}
	return parts.join('\n\n');
}
