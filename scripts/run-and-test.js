import { spawn } from 'child_process';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // wait and retry
    }
    await delay(300);
  }
  throw new Error(`Service at ${url} did not become healthy in ${timeoutMs}ms`);
}

async function main() {
  console.log('🚀 Spawning Auth Service & Orchestrator Service for test run...');

  const authProcess = spawn('node', ['src/server.js'], {
    cwd: './auth-service',
    stdio: 'inherit',
    shell: true,
  });

  const orchProcess = spawn('node', ['src/server.js'], {
    cwd: './orchestrator-service',
    stdio: 'inherit',
    shell: true,
  });

  try {
    console.log('⏳ Waiting for microservices to initialize...');
    await waitForHealth('http://localhost:4000/health');
    await waitForHealth('http://localhost:3000/health');
    console.log('✅ Both microservices are healthy!\n');

    // Run E2E Test Suite
    const { spawnSync } = await import('child_process');
    const testResult = spawnSync('node', ['scripts/test-e2e.js'], {
      stdio: 'inherit',
      shell: true,
    });

    if (testResult.status !== 0) {
      process.exitCode = testResult.status || 1;
    }
  } catch (err) {
    console.error('❌ Error during test run:', err);
    process.exitCode = 1;
  } finally {
    console.log('🛑 Shutting down microservices...');
    authProcess.kill();
    orchProcess.kill();
    process.exit(process.exitCode || 0);
  }
}

main();
