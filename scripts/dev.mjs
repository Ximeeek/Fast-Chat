import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const isHost = process.argv.includes('--host');

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

console.log('\n==========================================');
console.log(' Starting FastChat Development Environment');
console.log('==========================================\n');

if (isHost) {
  const ips = getLocalIpAddresses();
  console.log('[Network Info] Listening on local network:');
  for (const ip of ips) {
    console.log(`  -> Room Web App: http://${ip}:5173/`);
    console.log(`  -> Signaling:    ws://${ip}:3000/ws`);
  }
  console.log('');
}

const processes = [];

const cargoCmd = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const signaling = spawn(cargoCmd, ['run'], {
  cwd: path.join(rootDir, 'services', 'signaling'),
  stdio: 'inherit',
  shell: true
});
processes.push(signaling);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const frontendArgs = ['--prefix', 'apps/room', 'run', 'dev'];
if (isHost) {
  frontendArgs.push('--', '--host');
}

const frontend = spawn(npmCmd, frontendArgs, {
  cwd: rootDir,
  stdio: 'inherit',
  shell: true
});
processes.push(frontend);

function cleanup() {
  console.log('\nShutting down dev servers...');
  for (const proc of processes) {
    if (!proc.killed) {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t']);
      } else {
        proc.kill('SIGINT');
      }
    }
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
