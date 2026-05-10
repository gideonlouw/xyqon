import { spawn } from 'node:child_process';

const commands = [
  ['api', 'node', ['server/xyqon-api.mjs']],
  ['web', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200']]
];

const children = commands.map(([name, command, args]) => {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      for (const other of children) {
        if (other !== child) {
          other.kill();
        }
      }
      process.exit(code);
    }
  });
  return child;
});

process.on('SIGINT', () => {
  for (const child of children) {
    child.kill();
  }
  process.exit(0);
});
