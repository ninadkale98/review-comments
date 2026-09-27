import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface Comment {
    id: string;
    /** Absolute path of the commented file. */
    file: string;
    /** 0-indexed start line in the source. */
    line: number;
    /** 0-indexed end line; equals `line` for a single-line comment. */
    endLine: number;
    /** Column range, when the comment targets a phrase rather than whole lines. */
    startCol?: number;
    endCol?: number;
    /** The text as it read when the comment was made — used to re-anchor later. */
    quoted: string;
    /** The reviewer's note. */
    body: string;
    createdAt: number;
}

export interface Session {
    id: string;
    /** Which workspace this session belongs to. */
    workspaceKey: string;
    name: string;
    createdAt: number;
    /** Archived sessions stay readable but take no new comments. */
    completed: boolean;
    comments: Comment[];
}

interface StoreFile {
    version: 1;
    sessions: Session[];
}

/**
 * Sessions live in the extension's global storage, never in the workspace.
 *
 * Workspace state would put the file inside a repo (needing a .gitignore entry)
 * and would be lost whenever the folder set changes; global storage keyed by
 * workspace avoids both.
 */
export class Store {
    private file: string;
    private data: StoreFile = { version: 1, sessions: [] };

    /**
     * Serialises writes.
     *
     * Two saves in flight at once raced over the same temp filename: whichever
     * renamed first removed it, and the other failed with ENOENT, losing that
     * write. Chaining them keeps the temp file private to each save.
     */
    private writing: Promise<void> = Promise.resolve();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.file = path.join(context.globalStorageUri.fsPath, 'sessions.json');
    }

    /**
     * Identity for the current window.
     *
     * A `.code-workspace` file is a stable path, so it wins. Otherwise the key
     * comes from the FIRST workspace folder only: folders get added and removed
     * from a multi-root window routinely, and hashing all of them would orphan
     * a session the moment one changed.
     */
    static workspaceKey(): string {
        const wsFile = vscode.workspace.workspaceFile;
        if (wsFile && wsFile.scheme !== 'untitled') {
            return 'ws:' + wsFile.fsPath;
        }
        const first = vscode.workspace.workspaceFolders?.[0];
        if (!first) { return 'none'; }
        return 'dir:' + first.uri.fsPath;
    }

    /** Human-readable name for the current workspace, for display only. */
    static workspaceLabel(): string {
        const wsFile = vscode.workspace.workspaceFile;
        if (wsFile && wsFile.scheme !== 'untitled') {
            return path.basename(wsFile.fsPath, '.code-workspace');
        }
        const first = vscode.workspace.workspaceFolders?.[0];
        return first ? path.basename(first.uri.fsPath) : 'no folder';
    }

    async load(): Promise<void> {
        try {
            await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
            const raw = await fs.promises.readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw) as StoreFile;
            if (parsed && Array.isArray(parsed.sessions)) { this.data = parsed; }
        } catch {
            // Missing or corrupt file: start empty rather than failing activation.
            this.data = { version: 1, sessions: [] };
        }
    }

    /**
     * Persist, then notify.
     *
     * `notify: false` is for a write that is part of a larger operation — the
     * session auto-created by `addComment`, for instance. Firing there would
     * make the UI render a session with no comments in it, a beat before the
     * comment arrives, which is what made the status-bar count lag.
     */
    private async save(notify = true): Promise<void> {
        // Queue behind any save already running, and keep the chain alive even
        // if one link rejects.
        const run = this.writing.then(() => this.writeNow(), () => this.writeNow());
        this.writing = run.catch(() => undefined);
        await run;
        if (notify) { this._onDidChange.fire(); }
    }

    private async writeNow(): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        // Write then rename, so a crash mid-write cannot truncate the store.
        // The pid and a counter keep concurrent saves off each other's temp file.
        const tmp = `${this.file}.${process.pid}.${Store.seq++}.tmp`;
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
            await fs.promises.rename(tmp, this.file);
        } catch (err) {
            await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
            throw err;
        }
    }

    /** Distinguishes temp files created within the same millisecond. */
    private static seq = 0;

    /** Where the store lives, for the "reveal in finder" affordance. */
    get storePath(): string { return this.file; }

    /** Sessions for this workspace, newest first. */
    sessions(): Session[] {
        const key = Store.workspaceKey();
        return this.data.sessions
            .filter((s) => s.workspaceKey === key)
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /** Sessions belonging to other workspaces, so nothing is ever truly lost. */
    otherWorkspaceSessions(): Session[] {
        const key = Store.workspaceKey();
        return this.data.sessions.filter((s) => s.workspaceKey !== key);
    }

    activeSession(): Session | undefined {
        return this.sessions().find((s) => !s.completed);
    }

    /** The active session, creating one if none is open. */
    async ensureSession(): Promise<Session> {
        const existing = this.activeSession();
        if (existing) { return existing; }
        // Silent: the caller is mid-operation and will save again.
        return this.newSession(undefined, false);
    }

    async newSession(name?: string, notify = true): Promise<Session> {
        // Any open session is archived first: exactly one is active at a time.
        for (const s of this.data.sessions) {
            if (s.workspaceKey === Store.workspaceKey() && !s.completed) { s.completed = true; }
        }

        const session: Session = {
            id: crypto.randomUUID(),
            workspaceKey: Store.workspaceKey(),
            name: name || defaultName(),
            createdAt: Date.now(),
            completed: false,
            comments: [],
        };
        this.data.sessions.push(session);
        await this.save(notify);
        return session;
    }

    async addComment(c: Omit<Comment, 'id' | 'createdAt'>): Promise<Comment> {
        const session = await this.ensureSession();
        const comment: Comment = { ...c, id: crypto.randomUUID(), createdAt: Date.now() };
        session.comments.push(comment);
        await this.save();
        return comment;
    }

    async updateComment(id: string, body: string): Promise<void> {
        for (const s of this.data.sessions) {
            const c = s.comments.find((x) => x.id === id);
            if (c) { c.body = body; await this.save(); return; }
        }
    }

    async deleteComment(id: string): Promise<void> {
        for (const s of this.data.sessions) {
            const i = s.comments.findIndex((x) => x.id === id);
            if (i >= 0) { s.comments.splice(i, 1); await this.save(); return; }
        }
    }

    async clearComments(sessionId: string): Promise<void> {
        const s = this.data.sessions.find((x) => x.id === sessionId);
        if (s) { s.comments = []; await this.save(); }
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        const s = this.data.sessions.find((x) => x.id === sessionId);
        if (s) { s.name = name; await this.save(); }
    }

    async setCompleted(sessionId: string, completed: boolean): Promise<void> {
        const s = this.data.sessions.find((x) => x.id === sessionId);
        if (!s) { return; }
        // Reopening archives whatever else is open, keeping one active session.
        if (!completed) {
            for (const o of this.data.sessions) {
                if (o.workspaceKey === s.workspaceKey && o.id !== s.id) { o.completed = true; }
            }
        }
        s.completed = completed;
        await this.save();
    }

    async deleteSession(sessionId: string): Promise<void> {
        const i = this.data.sessions.findIndex((x) => x.id === sessionId);
        if (i >= 0) { this.data.sessions.splice(i, 1); await this.save(); }
    }

    /** Re-home a session from another workspace onto this one. */
    async adoptSession(sessionId: string): Promise<void> {
        const s = this.data.sessions.find((x) => x.id === sessionId);
        if (!s) { return; }
        s.workspaceKey = Store.workspaceKey();
        await this.save();
    }

    findSession(sessionId: string): Session | undefined {
        return this.data.sessions.find((x) => x.id === sessionId);
    }
}

/** Default session name: the git branch if we can cheaply tell, else the date. */
function defaultName(): string {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `review ${stamp}`;
}

function pad(n: number): string { return n < 10 ? `0${n}` : `${n}`; }
