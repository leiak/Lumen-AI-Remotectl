import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Returns a path to a node script that emits fake NDJSON to stdout
export async function spawnFakeClaude(): Promise<string> {
  const script = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'session_start',session_id:'fake-abc-123'}) + '\\n');
process.stdout.write(JSON.stringify({type:'assistant_text',content:'Reading files...'}) + '\\n');
process.stdout.write(JSON.stringify({type:'tool_use',name:'Read',input:{file_path:'src/foo.ts'}}) + '\\n');
process.stdout.write(JSON.stringify({type:'assistant_text',content:'Done.'}) + '\\n');
process.stdout.write(JSON.stringify({type:'session_end',exit_code:0}) + '\\n');
`;
  const p = path.join(os.tmpdir(), `fake-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, script);
  return Promise.resolve(p);
}
