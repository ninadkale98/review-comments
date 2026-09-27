import * as path from 'path';
import * as vscode from 'vscode';
import { Comment, Session, Store } from './store';

/**
 * Everything the user sees: gutter markers, the side panel, the status bar.
 *
 * Deliberately built on plain text decorations rather than the Comments API.
 * That API renders threads inline, but it also forces VS Code's own Comments
 * panel open at the bottom of the window on every change — it cannot be
 * suppressed from an extension. Decorations plus a hover give the same
 * information and leave the bottom of the screen alone.
 */
export class Ui {
    private readonly marker: vscode.TextEditorDecorationType;

    /**
     * Used only for the input box that appears at the commented line.
     *
     * The Comments API is the one way to get a text box inline in the editor.
     * Stored comments are drawn as gutter icons instead of threads, so nothing
     * of ours lives in VS Code's Comments panel; a draft thread exists only
     * while it is being typed into and is disposed on submit or cancel.
     */
    private readonly controller: vscode.CommentController;
    private drafts = new Map<vscode.CommentThread, Draft>();
    private readonly status: vscode.StatusBarItem;
    private readonly statusNew: vscode.StatusBarItem;
    private readonly tree: SessionTree;
    private readonly view: vscode.TreeView<TreeNode>;
    private readonly hover: vscode.Disposable;

    constructor(
        private readonly store: Store,
        extensionUri: vscode.Uri,
    ) {
        // A real gutter icon, in the left margin beside the line number, where
        // breakpoints and git marks live — scannable down the file at a glance.
        this.marker = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter.png'),
            gutterIconSize: 'contain',
            isWholeLine: true,
            overviewRulerColor: '#e2a03fcc',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        });

        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
        this.status.command = 'reviewComments.copyPrompt';

        this.statusNew = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusNew.command = 'reviewComments.newSession';
        this.statusNew.text = '$(add)';
        this.statusNew.tooltip = 'Review Comments: start a new session';

        this.controller = vscode.comments.createCommentController(
            'reviewCommentsInput', 'Review Comment',
        );
        this.controller.options = {
            placeHolder: 'What should change here?',
            prompt: 'Add review comment',
        };

        this.tree = new SessionTree(store);
        this.view = vscode.window.createTreeView('reviewComments.tree', {
            treeDataProvider: this.tree,
        });

        // Hovering a commented line shows the note, replacing what the inline
        // thread widget used to do.
        this.hover = vscode.languages.registerHoverProvider({ scheme: 'file' }, {
            provideHover: (doc, position) => {
                const hit = (this.store.activeSession()?.comments ?? []).find(
                    (c) => c.file === doc.uri.fsPath
                        && position.line >= c.line && position.line <= c.endLine,
                );
                if (!hit) { return undefined; }

                const md = new vscode.MarkdownString(
                    `**Review comment**\n\n${hit.body}`,
                );
                md.isTrusted = true;
                return new vscode.Hover(md);
            },
        });
    }

    dispose(): void {
        this.closeAllDrafts();
        this.controller.dispose();
        this.marker.dispose();
        this.status.dispose();
        this.statusNew.dispose();
        this.view.dispose();
        this.hover.dispose();
    }

    /** Rewrite every surface from the store. Safe to call as often as needed. */
    render(): void {
        const session = this.store.activeSession();
        const comments = session?.comments ?? [];

        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme !== 'file') { continue; }
            const ranges = comments
                .filter((c) => c.file === editor.document.uri.fsPath)
                .filter((c) => c.line < editor.document.lineCount)
                .map((c) => new vscode.Range(
                    c.line, 0,
                    Math.min(c.endLine, editor.document.lineCount - 1), 0,
                ));
            editor.setDecorations(this.marker, ranges);
        }

        this.renderStatus(session);
        this.tree.refresh();
        this.view.badge = comments.length
            ? { value: comments.length, tooltip: `${comments.length} review comments` }
            : undefined;
    }

    private renderStatus(session: Session | undefined): void {
        const on = vscode.workspace.getConfiguration('reviewComments')
            .get<boolean>('showStatusBar', true);
        if (!on) {
            this.status.hide();
            this.statusNew.hide();
            return;
        }

        const n = session?.comments.length ?? 0;
        this.status.text = n
            ? `$(comment-discussion) ${n}  $(clippy)`
            : '$(comment-discussion) Review';
        this.status.tooltip = n
            ? `${n} comment${n === 1 ? '' : 's'} in "${session?.name}" — click to copy the prompt`
            : 'Select code and press ⌘K C / Ctrl+K C to add a review comment';
        this.status.show();
        this.statusNew.show();
    }

    /** Open an empty comment box at the selection. */
    openDraft(editor: vscode.TextEditor): void {
        // Only ever one box at a time. Without this, each invocation stacked
        // another thread on the same line — abandoned drafts are never
        // submitted, so nothing else would ever dispose them.
        this.closeAllDrafts();

        const sel = editor.selection;
        const doc = editor.document;
        const quoted = sel.isEmpty
            ? doc.lineAt(sel.start.line).text.trim()
            : doc.getText(sel);

        const thread = this.controller.createCommentThread(
            doc.uri, new vscode.Range(sel.start.line, 0, sel.end.line, 0), [],
        );
        thread.label = `${path.basename(doc.fileName)}:${sel.start.line + 1}`;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.canReply = true;

        this.drafts.set(thread, {
            file: doc.uri.fsPath,
            startLine: sel.start.line,
            endLine: sel.isEmpty ? sel.start.line : sel.end.line,
            startCol: sel.isSingleLine && !sel.isEmpty ? sel.start.character : undefined,
            endCol: sel.isSingleLine && !sel.isEmpty ? sel.end.character : undefined,
            quoted,
        });
    }

    /** Store a submitted draft and close its box. */
    async submitDraft(reply: vscode.CommentReply): Promise<void> {
        const body = reply.text.trim();
        const draft = this.drafts.get(reply.thread);
        this.cancelDraft(reply.thread);
        if (!body || !draft) { return; }

        await this.store.addComment({
            file: draft.file,
            line: draft.startLine,
            endLine: draft.endLine,
            startCol: draft.startCol,
            endCol: draft.endCol,
            quoted: draft.quoted,
            body,
        });
    }

    cancelDraft(thread: vscode.CommentThread): void {
        this.drafts.delete(thread);
        thread.dispose();
    }

    /** Dispose every open draft box. */
    closeAllDrafts(): void {
        for (const thread of this.drafts.keys()) { thread.dispose(); }
        this.drafts.clear();
    }

    /** Reveal a comment in the side panel. */
    focus(comment: Comment): void {
        this.tree.refresh();
        void this.view.reveal({ kind: 'comment', comment }, { select: true, focus: false })
            .then(undefined, () => undefined);
    }
}

interface Draft {
    file: string;
    startLine: number;
    endLine: number;
    startCol?: number;
    endCol?: number;
    quoted: string;
}

// --- Tree -------------------------------------------------------------------

export type TreeNode =
    | { kind: 'session'; session: Session }
    | { kind: 'file'; session: Session; file: string }
    | { kind: 'comment'; comment: Comment }
    | { kind: 'pastHeader' }
    | { kind: 'empty'; message: string };

class SessionTree implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private readonly store: Store) {}

    refresh(): void { this._onDidChange.fire(); }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        switch (node.kind) {
            case 'session': return sessionItem(node.session);
            case 'file': return fileItem(node);
            case 'comment': return commentItem(node.comment);
            case 'pastHeader': {
                const item = new vscode.TreeItem(
                    'Past sessions', vscode.TreeItemCollapsibleState.Collapsed,
                );
                item.iconPath = new vscode.ThemeIcon('history');
                return item;
            }
            case 'empty': {
                const item = new vscode.TreeItem(node.message);
                item.iconPath = new vscode.ThemeIcon('info');
                return item;
            }
        }
    }

    getChildren(node?: TreeNode): TreeNode[] {
        const sessions = this.store.sessions();

        if (!node) {
            const active = sessions.find((s) => !s.completed);
            const past = sessions.filter((s) => s.completed);
            const out: TreeNode[] = [];

            out.push(active
                ? { kind: 'session', session: active }
                : { kind: 'empty', message: 'No comments yet — select code, press ⌘K C' });

            if (past.length) { out.push({ kind: 'pastHeader' }); }
            return out;
        }

        if (node.kind === 'pastHeader') {
            return sessions
                .filter((s) => s.completed)
                .map((session) => ({ kind: 'session' as const, session }));
        }

        if (node.kind === 'session') {
            return [...new Set(node.session.comments.map((c) => c.file))]
                .sort()
                .map((file) => ({ kind: 'file' as const, session: node.session, file }));
        }

        if (node.kind === 'file') {
            return node.session.comments
                .filter((c) => c.file === node.file)
                .sort((a, b) => a.line - b.line)
                .map((comment) => ({ kind: 'comment' as const, comment }));
        }

        return [];
    }

    /** Needed for reveal(); the panel only ever nests three levels. */
    getParent(node: TreeNode): TreeNode | undefined {
        if (node.kind !== 'comment') { return undefined; }
        const session = this.store.activeSession();
        if (!session) { return undefined; }
        return { kind: 'file', session, file: node.comment.file };
    }
}

function sessionItem(s: Session): vscode.TreeItem {
    const files = new Set(s.comments.map((c) => c.file)).size;
    const item = new vscode.TreeItem(
        s.name,
        s.comments.length
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None,
    );
    item.contextValue = s.completed ? 'pastSession' : 'activeSession';
    item.iconPath = new vscode.ThemeIcon(s.completed ? 'archive' : 'circle-filled');
    item.description = s.completed
        ? `${s.comments.length} comment${s.comments.length === 1 ? '' : 's'} · ${ago(s.createdAt)}`
        : `${files} file${files === 1 ? '' : 's'} · ${s.comments.length} comment${s.comments.length === 1 ? '' : 's'}`;
    return item;
}

function fileItem(node: { session: Session; file: string }): vscode.TreeItem {
    const n = node.session.comments.filter((c) => c.file === node.file).length;
    const item = new vscode.TreeItem(
        path.basename(node.file), vscode.TreeItemCollapsibleState.Expanded,
    );
    item.resourceUri = vscode.Uri.file(node.file);
    item.description = `${n}`;
    item.tooltip = node.file;
    return item;
}

function commentItem(c: Comment): vscode.TreeItem {
    const item = new vscode.TreeItem(`L${c.line + 1}  ${oneLine(c.body, 60)}`);
    item.contextValue = 'comment';
    item.iconPath = new vscode.ThemeIcon('comment');
    item.description = oneLine(c.quoted, 40);
    item.tooltip = new vscode.MarkdownString(
        `\`${oneLine(c.quoted, 120)}\`\n\n${c.body}`,
    );
    item.command = { command: 'reviewComments.jumpTo', title: 'Go to Comment', arguments: [c] };
    return item;
}

function oneLine(s: string, max: number): string {
    const flat = s.replace(/\s*\n\s*/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function ago(ts: number): string {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) { return 'just now'; }
    if (mins < 60) { return `${mins}m ago`; }
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) { return `${hrs}h ago`; }
    return `${Math.floor(hrs / 24)}d ago`;
}
