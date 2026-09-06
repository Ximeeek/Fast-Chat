import type { ChatMessage } from './types.ts';

/**
 * Formats in-memory decrypted chat messages into a clean, human-readable text document.
 *
 * @param roomCode - The active room code.
 * @param messages - Decrypted messages from volatile in-memory storage.
 * @param exportedAt - Date of export (defaults to now).
 * @returns Plain text formatted chat log.
 */
export function formatChatLog(
	roomCode: string,
	messages: ChatMessage[],
	exportedAt: Date = new Date()
): string {
	const utcDate = exportedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
	const divider = '='.repeat(80);

	const lines: string[] = [
		'FastChat Room Chat Log',
		divider,
		`Room Code:    ${roomCode || 'Unknown'}`,
		`Exported At:  ${utcDate}`,
		`Messages:     ${messages.length}`,
		divider,
		''
	];

	if (messages.length === 0) {
		lines.push('(No messages recorded in this session)', '');
	} else {
		for (const msg of messages) {
			const d = new Date(msg.timestamp);
			const timeStr = d.toISOString().slice(11, 19); // HH:MM:SS
			const body = Array.isArray(msg.segments)
				? msg.segments
						.map((seg) =>
							seg.type === 'code'
								? (seg.language ? `\`\`\`${seg.language}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``)
								: seg.text
						)
						.join('\n\n')
				: ((msg as any).content || '');

			if (msg.isSystem) {
				lines.push(`[${timeStr}] [SYSTEM]: ${body}`);
			} else {
				const senderBadge = msg.isSelf ? `${msg.sender} (You)` : msg.sender;
				lines.push(`[${timeStr}] ${senderBadge}: ${body}`);
			}
		}
		lines.push('');
	}

	lines.push(divider, 'End of Chat Log');

	return lines.join('\n');
}

/**
 * Triggers a client-side file download of the chat log text content using native
 * browser Blob and URL.createObjectURL APIs.
 *
 * Zero network roundtrips: no server calls, WebSockets, or HTTP endpoints are touched.
 *
 * @param filename - Name of the output .txt file.
 * @param content - Text content of the chat log.
 */
export function downloadChatLog(filename: string, content: string): void {
	if (typeof window === 'undefined' || typeof document === 'undefined') {
		return;
	}

	const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');

	anchor.href = url;
	anchor.download = filename;
	anchor.style.display = 'none';

	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);

	URL.revokeObjectURL(url);
}
