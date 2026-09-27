#!/usr/bin/env node
import { startCommand } from './commands/start.js';
import { tokenCommand } from './commands/token.js';

const [, , subcommand] = process.argv;

switch (subcommand) {
  case 'start':
    await startCommand();
    break;
  case 'token':
    await tokenCommand();
    break;
  default:
    console.log('Usage: remotectl <start|token>');
    console.log('  start  Start the server');
    console.log('  token  Print the current API token');
    process.exit(1);
}