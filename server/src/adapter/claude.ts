import { spawn, type ChildProcess } from 'node:child_process';

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
  done: Promise<{ sessionId: string | null; exitCode: number }>;
}

export class ClaudeAdapter {
  constructor(private cfg: ClaudeConfig) {}

  start(opts: ClaudeStartOpts, onEvent: (e: ClaudeEvent) => void): ClaudeHandle {
    const args = [...this.cfg.baseArgs];
    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.prompt) args.push(opts.prompt);
    args.push('--cwd', this.cfg.workspacePath);

    const proc: ChildProcess = spawn(this.cfg.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let buf = '';
    let sessionId: string | null = null;
    let resolveDone!: (v: { sessionId: string | null; exitCode: number }) => void;

    const done = new Promise<{ sessionId: string | null; exitCode: number }>((res) => {
      resolveDone = res;
    });

    const handleLine = (line: string) => {
      if (!line.trim()) return;
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
      resolveDone({ sessionId, exitCode: code ?? 0 });
    });

    return {
      stdin: { write: (s: string) => proc.stdin?.write(s) },
      done,
    };
  }
}
