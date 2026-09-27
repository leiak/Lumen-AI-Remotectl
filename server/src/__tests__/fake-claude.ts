import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface FakeClaudeHandle {
  path: string;
  cleanup: () => void;
}

// Returns a handle to a node script that emits fake NDJSON to stdout.
// The script also writes one error event to stderr and one non-JSON line.
// Call cleanup() to delete the script file when done.
export async function spawnFakeClaude(opts: { exitCode?: number } = {}): Promise<FakeClaudeHandle> {
  const exitCode = opts.exitCode ?? 0;
  const script = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'session_start',session_id:'fake-abc-123'}) + '\\n');
process.stdout.write('not a json line, just plain text\\n');
process.stdout.write(JSON.stringify({type:'assistant_text',content:'Reading files...'}) + '\\n');
process.stdout.write(JSON.stringify({type:'tool_use',name:'Read',input:{file_path:'src/foo.ts'}}) + '\\n');
process.stdout.write(JSON.stringify({type:'assistant_text',content:'Done.'}) + '\\n');
process.stdout.write(JSON.stringify({type:'session_end',exit_code:${exitCode}}) + '\\n');
process.stderr.write('something went wrong\\n');
process.exit(${exitCode});
`;
  const p = path.join(os.tmpdir(), `fake-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, script);
  return {
    path: p,
    cleanup: () => {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    },
  };
}
