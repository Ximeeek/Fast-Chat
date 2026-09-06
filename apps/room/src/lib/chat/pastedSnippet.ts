import { getLanguageDisplayName, detectLanguage } from './languageDetection.ts';
import { isCodeSnippet } from './codeDetection.ts';
import type { MessageSegment } from './types.ts';

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
	contentType: 'text' | 'code';
	/** Detected or manually selected programming language (null = plain code / plain text) */
	language: string | null;
	/** Selection mode: auto heuristic evaluation or manual user lock */
	languageMode: 'auto' | 'manual';
}

/**
 * Composer item representation: either freely typed text or a pasted snippet block.
 */
export type ComposerBlock =
	| {
			kind: 'text';
			id: string;
			text: string;
	  }
	| (PastedBlock & { kind: 'paste' });

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
 * Creates a new independent PastedBlock, evaluating heuristics when in auto mode.
 */
export function createPastedBlock(
	content: string,
	options?: {
		contentType?: 'text' | 'code';
		language?: string | null;
		languageMode?: 'auto' | 'manual';
		id?: string;
	}
): PastedBlock {
	const lines = countLines(content);
	const isManual = options?.languageMode === 'manual';

	let contentType: 'text' | 'code';
	let language: string | null;

	if (isManual) {
		contentType = options?.contentType ?? (options?.language ? 'code' : 'text');
		language = options?.language !== undefined ? options.language : null;
	} else {
		const isCode = isCodeSnippet(content);
		contentType = options?.contentType ?? (isCode ? 'code' : 'text');
		language = contentType === 'code' ? detectLanguage(content) : null;
	}

	return {
		id: options?.id || `paste-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		content,
		lineCount: Math.max(lines, 1),
		isExpanded: false,
		contentType,
		language,
		languageMode: options?.languageMode || 'auto'
	};
}

/**
 * Iterates through the composer block sequence and companion input in exact chronological order
 * to assemble the outbound MessageSegment array ready for transmission.
 *
 * @param blocks - Ordered sequence of text items and pasted snippet blocks.
 * @param trailingInput - Optional companion text currently typed in the active input.
 * @param trailingInputOptions - Optional formatting parameters for trailing input.
 * @returns Ordered array of MessageSegment elements.
 */
export function buildMessageSegments(
	blocks: ComposerBlock[],
	trailingInput?: string,
	trailingInputOptions?: {
		isManualCodeMode?: boolean;
		manualLanguage?: string | null;
	}
): MessageSegment[] {
	const segments: MessageSegment[] = [];

	for (const block of blocks) {
		if (block.kind === 'text') {
			const trimmed = block.text.trim();
			if (trimmed.length > 0) {
				segments.push({
					type: 'text',
					text: trimmed
				});
			}
		} else if (block.kind === 'paste') {
			const trimmed = block.content.trim();
			if (trimmed.length > 0) {
				if (block.contentType === 'code') {
					segments.push({
						type: 'code',
						code: trimmed,
						language: block.language
					});
				} else {
					segments.push({
						type: 'text',
						text: trimmed
					});
				}
			}
		}
	}

	if (trailingInput) {
		const trimmed = trailingInput.trim();
		if (trimmed.length > 0) {
			if (trailingInputOptions?.isManualCodeMode) {
				segments.push({
					type: 'code',
					code: trimmed,
					language: trailingInputOptions.manualLanguage || detectLanguage(trimmed)
				});
			} else if (isCodeSnippet(trimmed)) {
				segments.push({
					type: 'code',
					code: trimmed,
					language: detectLanguage(trimmed)
				});
			} else {
				segments.push({
					type: 'text',
					text: trimmed
				});
			}
		}
	}

	return segments;
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
