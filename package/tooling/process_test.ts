import { runDenoStatus } from "./process.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test({
  name: "runDenoStatus distinguishes a forwarded shutdown signal from a child failure",
  ignore: Deno.build.os === "windows",
  async fn() {
    const moduleUrl = new URL("./process.ts", import.meta.url).href;
    const wrapperSource = `
      import { runDenoStatus } from ${JSON.stringify(moduleUrl)};
      const status = await runDenoStatus(
        ["eval", "console.log('READY'); await new Promise(() => {})"],
        {},
      );
      console.log("STATUS " + JSON.stringify(status));
      if (status.forwardedSignal !== "SIGTERM") Deno.exit(1);
    `;
    const wrapper = new Deno.Command(Deno.execPath(), {
      args: ["eval", wrapperSource],
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const reader = wrapper.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let stdout = "";
    try {
      while (!stdout.includes("READY")) {
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("signal test child did not become ready")), 5_000)
          ),
        ]);
        if (next.done) throw new Error(`signal test child exited before readiness: ${stdout}`);
        stdout += next.value;
      }
      wrapper.kill("SIGTERM");
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        stdout += next.value;
      }
      const [status, stderr] = await Promise.all([
        wrapper.status,
        new Response(wrapper.stderr).text(),
      ]);
      assert(status.success, `signal test wrapper failed (${status.code}): ${stderr}`);
      assert(
        stdout.includes('"forwardedSignal":"SIGTERM"'),
        `forwarded signal was not retained: ${stdout}`,
      );
    } finally {
      reader.releaseLock();
      try {
        wrapper.kill("SIGKILL");
      } catch {
        // The expected path already exited cleanly.
      }
    }

    const unexpected = await runDenoStatus(["eval", "Deno.exit(17)"], {});
    assert(unexpected.code === 17, `unexpected child code changed: ${unexpected.code}`);
    assert(unexpected.forwardedSignal === null, "ordinary child failure was marked as a shutdown");
  },
});
