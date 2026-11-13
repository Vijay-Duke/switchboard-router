import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("../../custom-server.js", import.meta.url));
const fixture = `
require(${JSON.stringify(wrapper)});
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.url === '/disconnected' || req.url === '/bug') {
    res.emit('error', Object.assign(new Error('response write failed'), {
      code: req.url === '/disconnected' ? 'EPIPE' : 'EINTERNAL'
    }));
    return;
  }
  res.end('ok');
});
process.on('message', ({ stream, bug }) => {
  if (bug) process.stdout.emit('error', Object.assign(new Error('stdio bug'), { code: 'EINTERNAL' }));
  else process[stream].write(Buffer.alloc(65536, 120), error => process.send({ writeError: error?.code }));
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
`;

function message(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error("fixture IPC timed out")); }, 5000);
    const received = (data) => { clean(); resolve(data); };
    const exited = (code) => { clean(); reject(new Error(`fixture exited ${code}`)); };
    const clean = () => { clearTimeout(timer); child.off("message", received); child.off("exit", exited); };
    child.once("message", received);
    child.once("exit", exited);
  });
}

async function withServer(run) {
  const child = spawn(process.execPath, ["-e", fixture], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stderr.resume();
  try {
    const { port } = await message(child);
    await run(child, `http://127.0.0.1:${port}`);
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
  }
}

describe("custom server broken pipes", () => {
  it("contains a disconnected response without terminating other requests", async () => {
    await withServer(async (_child, base) => {
      await fetch(base + "/disconnected").catch(() => null);
      expect(await (await fetch(base)).text()).toBe("ok");
    });
  });

  it.skipIf(process.platform === "win32").each(["stdout", "stderr"])("survives an actual closed %s pipe", async (stream) => {
    await withServer(async (child, base) => {
      child[stream].destroy();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const written = message(child);
      child.send({ stream });
      expect((await written).writeError).toBe("EPIPE");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await (await fetch(base)).text()).toBe("ok");
    });
  });

  it.each(["response", "stdio"])("keeps unexpected %s errors fatal", async (kind) => {
    await withServer(async (child, base) => {
      const ended = once(child, "exit");
      if (kind === "response") await fetch(base + "/bug").catch(() => null);
      else child.send({ bug: true });
      const [code] = await ended;
      expect(code).toBe(1);
    });
  });
});
