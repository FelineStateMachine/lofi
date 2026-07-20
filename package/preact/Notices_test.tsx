import { render } from "npm:preact-render-to-string@6.7.0";
import { getNoticeQueue } from "../runtime/mod.ts";
import { Notices } from "./Notices.tsx";

Deno.test("Notices keeps its empty live region exposed for the first announcement", () => {
  const html = render(<Notices />);
  if (!html.includes('aria-live="polite"')) {
    throw new Error("the durable notice surface omitted its live region");
  }
  if (html.includes(" hidden")) {
    throw new Error("an empty live region must remain in the accessibility tree");
  }
});

Deno.test("Notices preserves custom renderer markup without a wrapper", async () => {
  const queue = getNoticeQueue();
  const id = "notices-custom-renderer-test";
  await queue.enqueue({ id, message: "Custom", tone: "info", ttlMs: null });
  try {
    const html = render(
      <Notices>{(notice) => <article data-notice={notice.id}>{notice.message}</article>}</Notices>,
    );
    if (!html.includes(`<article data-notice="${id}">Custom</article>`)) {
      throw new Error("the custom notice renderer did not retain its own root markup");
    }
    if (html.includes("<div")) {
      throw new Error("the notices surface inserted a wrapper around custom markup");
    }
  } finally {
    queue.dismiss(id);
    await queue.flush();
  }
});
