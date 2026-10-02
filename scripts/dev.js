import { spawn } from 'child_process';

const startService = (name, cwd, port) => {
  const child = spawn('node', ['--watch', 'src/server.js'], {
    cwd,
    stdio: 'inherit',
    shell: true,
  });

  child.on('error', (err) => {
    console.error(`[${name}] Failed to start:`, err);
  });

  return child;
};

console.log('🚀 Starting Auth Service (port 4000) & Orchestrator Service (port 3000)...');
startService('AUTH', './auth-service', 4000);
startService('ORCHESTRATOR', './orchestrator-service', 3000);
