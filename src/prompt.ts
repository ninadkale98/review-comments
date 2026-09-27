import * as path from 'path';
import { Comment, Session } from './store';

/** Fence language guessed from the file extension, for readable code blocks. */
const LANG: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.swift': 'swift', '.c': 'c',
    '.h': 'c', '.cpp': 'cpp', '.cs': 'csharp', '.php': 'php',
    '.sh': 'bash', '.zsh': 'bash', '.yml': 'yaml', '.yaml': 'yaml',
    '.json': 'json', '.sql': 'sql', '.html': 'html', '.css': 'css',
    '.md': 'markdown', '.toml': 'toml',
};

/**
 * Render a session as a prompt for an AI agent.
 *
 * Shape matters as much as content: the quoted code travels with each comment
 * so the agent never has to guess what was meant, and the stable numbering
 * gives the reader something to refer to ("skip 3").
 */
export function buildPrompt(
    session: Session,
    header: string,
    workspaceRoot: string | undefined,
): string {
    const comments = [...session.comments].sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    );

    const fileCount = new Set(comments.map((c) => c.file)).size;
    const out: string[] = [];

    out.push(`# Review: ${session.name}`);
    out.push('');
    out.push(
        `${comments.length} comment${comments.length === 1 ? '' : 's'} across ` +
        `${fileCount} file${fileCount === 1 ? '' : 's'}.`,
    );
    if (header.trim()) { out.push(header.trim()); }
    out.push('');

    comments.forEach((c, i) => {
        const rel = workspaceRoot ? path.relative(workspaceRoot, c.file) : c.file;
        const loc = c.endLine > c.line ? `${c.line + 1}-${c.endLine + 1}` : `${c.line + 1}`;

        out.push(`## ${i + 1}. ${rel}:${loc}`);

        // A phrase-level comment reads better quoted inline; a line range wants
        // a fenced block so indentation and syntax survive.
        if (isPhrase(c)) {
            out.push(`> ${oneLine(c.quoted)}`);
            out.push('');
            out.push(`**Comment:** ${c.body.trim()}`);
        } else {
            const lang = LANG[path.extname(c.file).toLowerCase()] ?? '';
            out.push('```' + lang);
            out.push(c.quoted.replace(/\s+$/, ''));
            out.push('```');
            out.push('');
            out.push(`**Comment:** ${c.body.trim()}`);
        }
        out.push('');
    });

    return out.join('\n');
}

/** A comment on part of one line, rather than on whole lines. */
function isPhrase(c: Comment): boolean {
    return c.line === c.endLine
        && c.startCol !== undefined
        && !c.quoted.includes('\n')
        && c.quoted.length <= 200;
}

function oneLine(s: string): string {
    return s.replace(/\s*\n\s*/g, ' ').trim();
}
