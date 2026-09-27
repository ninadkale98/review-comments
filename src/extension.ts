import * as vscode from 'vscode';
import { buildPrompt } from './prompt';
import { Comment, Store } from './store';
import { TreeNode, Ui } from './ui';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const store = new Store(context);
    await store.load();

    const ui = new Ui(store, context.extensionUri);
    context.subscriptions.push(ui, store.onDidChange(() => ui.render()));

    /** The session a command acts on: the one clicked, else the active one. */
    const target = (node?: TreeNode) =>
        node?.kind === 'session' ? store.findSession(node.session.id) : store.activeSession();

    context.subscriptions.push(
        vscode.commands.registerCommand('reviewComments.add', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) { ui.openDraft(editor); }
        }),

        vscode.commands.registerCommand('reviewComments.submitDraft',
            (reply: vscode.CommentReply) => ui.submitDraft(reply)),

        vscode.commands.registerCommand('reviewComments.cancelDraft',
            (arg?: vscode.CommentReply | vscode.CommentThread) => {
                const thread = arg && 'thread' in arg ? arg.thread : arg;
                if (thread) { ui.cancelDraft(thread); }
            }),

        vscode.commands.registerCommand('reviewComments.editComment', async (node?: TreeNode) => {
            if (node?.kind !== 'comment') { return; }
            const body = await vscode.window.showInputBox({
                title: 'Edit comment',
                value: node.comment.body,
                ignoreFocusOut: true,
            });
            if (body?.trim()) { await store.updateComment(node.comment.id, body.trim()); }
        }),

        vscode.commands.registerCommand('reviewComments.deleteComment', async (node?: TreeNode) => {
            if (node?.kind === 'comment') { await store.deleteComment(node.comment.id); }
        }),

        vscode.commands.registerCommand('reviewComments.copyPrompt', async (node?: TreeNode) => {
            const session = target(node);
            if (!session?.comments.length) {
                vscode.window.showInformationMessage('No review comments to copy yet.');
                return;
            }

            const header = vscode.workspace.getConfiguration('reviewComments')
                .get<string>('promptHeader', '');
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            await vscode.env.clipboard.writeText(buildPrompt(session, header, root));

            const files = new Set(session.comments.map((c) => c.file)).size;
            vscode.window.showInformationMessage(
                `Copied ${session.comments.length} comment${session.comments.length === 1 ? '' : 's'} ` +
                `across ${files} file${files === 1 ? '' : 's'}.`,
            );
        }),

        vscode.commands.registerCommand('reviewComments.newSession', async () => {
            const current = store.activeSession();
            if (current?.comments.length) {
                const choice = await vscode.window.showWarningMessage(
                    `Archive "${current.name}" with its ${current.comments.length} comment(s) and start fresh?`,
                    { modal: true },
                    'Start New Session',
                );
                if (choice !== 'Start New Session') { return; }
            }

            const name = await vscode.window.showInputBox({
                title: 'New review session',
                prompt: 'Name (optional)',
                placeHolder: 'e.g. auth refactor',
            });
            if (name === undefined) { return; }
            await store.newSession(name.trim() || undefined);
        }),

        vscode.commands.registerCommand('reviewComments.completeSession', async (node?: TreeNode) => {
            const session = target(node);
            if (session) { await store.setCompleted(session.id, true); }
        }),

        vscode.commands.registerCommand('reviewComments.reopenSession', async (node?: TreeNode) => {
            if (node?.kind === 'session') { await store.setCompleted(node.session.id, false); }
        }),

        vscode.commands.registerCommand('reviewComments.renameSession', async (node?: TreeNode) => {
            const session = target(node);
            if (!session) { return; }
            const name = await vscode.window.showInputBox({
                title: 'Rename session', value: session.name,
            });
            if (name?.trim()) { await store.renameSession(session.id, name.trim()); }
        }),

        vscode.commands.registerCommand('reviewComments.clearComments', async (node?: TreeNode) => {
            const session = target(node);
            if (!session?.comments.length) { return; }
            const yes = await vscode.window.showWarningMessage(
                `Delete all ${session.comments.length} comments in "${session.name}"?`,
                { modal: true }, 'Clear',
            );
            if (yes === 'Clear') { await store.clearComments(session.id); }
        }),

        vscode.commands.registerCommand('reviewComments.deleteSession', async (node?: TreeNode) => {
            if (node?.kind !== 'session') { return; }
            const yes = await vscode.window.showWarningMessage(
                `Delete "${node.session.name}" and its ${node.session.comments.length} comments?`,
                { modal: true, detail: 'This cannot be undone.' }, 'Delete',
            );
            if (yes === 'Delete') { await store.deleteSession(node.session.id); }
        }),

        vscode.commands.registerCommand('reviewComments.jumpTo', async (c: Comment) => {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(c.file));
            const editor = await vscode.window.showTextDocument(doc);
            const line = Math.min(c.line, doc.lineCount - 1);
            const range = new vscode.Range(line, c.startCol ?? 0, line, c.endCol ?? 0);
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }),

        vscode.commands.registerCommand('reviewComments.refresh', () => ui.render()),

        vscode.window.onDidChangeVisibleTextEditors(() => ui.render()),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('reviewComments')) { ui.render(); }
        }),
    );

    ui.render();
}

export function deactivate(): void { /* disposed via subscriptions */ }

