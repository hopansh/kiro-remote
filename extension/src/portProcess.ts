import { execFile } from 'child_process';

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Find and forcibly stop processes listening on a TCP port. */
export async function killProcessesOnPort(port: number): Promise<number[]> {
  const killed: number[] = [];

  if (process.platform === 'win32') {
    const output = await run('netstat.exe', ['-ano', '-p', 'tcp']);
    const pids = new Set<number>();
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 4 || columns[0].toUpperCase() !== 'TCP') continue;
      if (!columns[1].endsWith(`:${port}`)) continue;
      const pid = Number(columns[columns.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    for (const pid of pids) {
      await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
      killed.push(pid);
    }
    return killed;
  }

  const output = await run('lsof', ['-ti', `tcp:${port}`]).catch(() => '');
  for (const value of output.split(/\r?\n/)) {
    const pid = Number(value.trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // The process may already have exited.
    }
  }
  return killed;
}

export async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  process.kill(pid, 'SIGTERM');
}

export function portReleaseHint(port: number): string {
  return process.platform === 'win32'
    ? `Run \"netstat -ano | findstr :${port}\" and then \"taskkill /PID <pid> /T /F\", or change kiroRemote.relayPort.`
    : `Run \"lsof -ti tcp:${port} | xargs kill -9\", or change kiroRemote.relayPort.`;
}
