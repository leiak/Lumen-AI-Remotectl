import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const issues = sqliteTable('issues', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status', { enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'] }).notNull().default('todo'),
  priority: text('priority', { enum: ['low', 'medium', 'high'] }).notNull().default('medium'),
  workspacePath: text('workspace_path').notNull(),
  currentSessionId: text('current_session_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  issueId: text('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  authorType: text('author_type', { enum: ['user', 'agent', 'system'] }).notNull(),
  body: text('body').notNull(),
  kind: text('kind', { enum: ['message', 'approval_request', 'approval_response', 'tool_use', 'tool_result', 'system'] }).notNull().default('message'),
  parentId: text('parent_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  issueId: text('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'cancelled'] }).notNull(),
  trigger: text('trigger', { enum: ['manual', 'on_comment', 'on_approval', 'on_retry'] }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  costCents: integer('cost_cents').default(0),
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  error: text('error'),
});

export const runEvents = sqliteTable('run_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  stream: text('stream', { enum: ['stdout', 'stderr', 'system'] }).notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const pushDevices = sqliteTable('push_devices', {
  id: text('id').primaryKey(),
  deviceToken: text('device_token').notNull().unique(),
  platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
});

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  tailscaleIp: text('tailscale_ip'),
  apiKeyHash: text('api_key_hash').notNull(),
  workspaceDefault: text('workspace_default').notNull(),
  pushEnabled: integer('push_enabled', { mode: 'boolean' }).notNull().default(true),
});
