export async function runDeno(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  cwd = Deno.cwd(),
): Promise<number> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [...args],
    cwd,
    clearEnv: true,
    env: { ...environment },
    stdin: "inherit",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const forward = (
    stream: ReadableStream<Uint8Array>,
    target: WritableStream<Uint8Array>,
  ) => stream.pipeTo(target, { preventClose: true });
  const forwardSignal = (signal: Deno.Signal) => {
    try {
      child.kill(signal);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  Deno.addSignalListener("SIGINT", onInterrupt);
  Deno.addSignalListener("SIGTERM", onTerminate);
  try {
    const [status] = await Promise.all([
      child.status,
      forward(child.stdout, Deno.stdout.writable),
      forward(child.stderr, Deno.stderr.writable),
    ]);
    return status.code;
  } finally {
    Deno.removeSignalListener("SIGINT", onInterrupt);
    Deno.removeSignalListener("SIGTERM", onTerminate);
  }
}
