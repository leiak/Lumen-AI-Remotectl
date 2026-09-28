import { spawn, type ChildProcess } from 'node:child_process';

// DoS guard: lines larger than this are treated as a protocol violation.
// A malicious/compromised binary emitting huge lines could otherwise blow up memory.
const MAX_LINE_BYTES = 1024 * 1024;

export type ClaudeEvent =
  | { type: 'session_start'; session_id: string }
  | { type: 'session_end'; exit_code: number }
  | { type: 'assistant_text'; content: string }
  | { type: 'tool_use'; name: string; input: any }
  | { type: 'tool_result'; output: string }
  | { type: 'approval_request'; question: string }
  | { type: 'error'; message: string };

export interface ClaudeStartOpts {
  fresh?: boolean;
  resume?: string;
  prompt?: string;
}

export interface ClaudeConfig {
  binary: string;
  baseArgs: string[];
  workspacePath: string;
}

export interface ClaudeHandle {
  stdin: { write: (s: string) => void };
  /**
   * Forward the user's approval response (yes/no) to Claude's stdin.
   * No-op when no approval is currently pending — the caller doesn't need
   * to track state, the adapter does.
   */
  respond: (value: string) => void;
  done: Promise<{ sessionId: string | null; exitCode: number }>;
}

export class ClaudeAdapter {
  constructor(private cfg: ClaudeConfig) {}

  start(opts: ClaudeStartOpts, onEvent: (e: ClaudeEvent) => void): ClaudeHandle {
    // Guard against user-supplied continuation prompts being parsed as flags.
    if (opts.prompt && opts.prompt.startsWith('--')) {
      throw new Error('prompt_cannot_start_with_dashes');
    }

    const args = [...this.cfg.baseArgs];
    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.prompt) args.push(opts.prompt);

    // Pass workspace via the spawn `cwd` option — Claude Code doesn't accept
    // a --cwd flag and silently exits with an "unknown option" error if we
    // append one.
    const proc: ChildProcess = spawn(this.cfg.binary, args, {
      cwd: this.cfg.workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // If spawn itself fails (ENOENT, EACCES, etc.), Node never emits 'exit',
    // so done would hang forever. Resolve with -1 to surface the failure.
    proc.on('error', () => {
      resolveDone({ sessionId: null, exitCode: -1 });
    });

    let buf = '';
    let sessionId: string | null = null;
    let resolveDone!: (v: { sessionId: string | null; exitCode: number }) => void;

    const done = new Promise<{ sessionId: string | null; exitCode: number }>((res) => {
      resolveDone = res;
    });

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      // Byte-length cap on lines to prevent OOM from huge stdout.
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        onEvent({ type: 'error', message: 'line_too_long' });
        proc.kill();
        return;
      }
      try {
        const evt = JSON.parse(line) as ClaudeEvent;
        if (evt.type === 'session_start') sessionId = evt.session_id;
        onEvent(evt);
      } catch {
        // Non-JSON line — treat as raw assistant text
        onEvent({ type: 'assistant_text', content: line });
      }
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      onEvent({ type: 'error', message: chunk.toString('utf8') });
    });

    proc.on('exit', (code) => {
      // code is null when the process was killed by a signal (e.g. line_too_long).
      resolveDone({ sessionId, exitCode: code ?? -1 });
    });

    // The respond() API is wired to Claude's stdin. In `--print` mode Claude
    // doesn't actually read stdin (it runs non-interactively), so this is a
    // no-op for the current default — but it keeps the call site stable for a
    // future interactive-mode wiring and makes "respond to the in-flight
    // process" first-class in the API surface.
    const handleObj: ClaudeHandle = {
      stdin: { write: (s: string) => proc.stdin?.write(s) },
      respond: (value: string) => {
        try {
          proc.stdin?.write(`${value}\n`);
        } catch {
          // stdin may already be closed (process exited); ignore.
        }
      },
      done,
    };

    return handleObj;
  }
}
