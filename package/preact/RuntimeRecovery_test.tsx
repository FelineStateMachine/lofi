import { render } from "npm:preact-render-to-string@6.7.0";
import { RuntimeRecovery } from "./RuntimeRecovery.tsx";

Deno.test("RuntimeRecovery explains the explicit incompatible-broker action", () => {
  const html = render(
    <RuntimeRecovery
      failure={{
        code: "broker-incompatible",
        runtimeMode: "managed",
        message:
          "Another tab for this app is running an incompatible version. Close every other app tab, then reload this tab.",
      }}
    />,
  );
  for (
    const text of ["Close other app tabs", "will not reload or retry automatically", "Reload app"]
  ) {
    if (!html.includes(text)) throw new Error(`recovery UI omitted: ${text}`);
  }
});

Deno.test("RuntimeRecovery stays hidden for startup failures without a browser-tab action", () => {
  const html = render(
    <RuntimeRecovery
      failure={{
        code: "unsupported-capabilities",
        runtimeMode: "local",
        message: "unsupported",
      }}
    />,
  );
  if (html) throw new Error("generic startup failure rendered broker recovery");
});
