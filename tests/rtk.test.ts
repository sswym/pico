import { expect, test } from "bun:test";
import { rewriteRtkCommand, shouldRewriteWithRtk } from "../src/extensions/rtk/index.ts";

test("shouldRewriteWithRtk accepts compact shell commands", () => {
  expect(shouldRewriteWithRtk("git status")).toBe(true);
  expect(shouldRewriteWithRtk("rg foo src")).toBe(true);
  expect(shouldRewriteWithRtk("cargo test")).toBe(true);
});

test("shouldRewriteWithRtk skips already wrapped or interactive commands", () => {
  expect(shouldRewriteWithRtk("rtk git status")).toBe(false);
  expect(shouldRewriteWithRtk("cd ..")).toBe(false);
  expect(shouldRewriteWithRtk("source .env")).toBe(false);
  expect(shouldRewriteWithRtk("bun run start")).toBe(false);
});

test("rewriteRtkCommand prepends rtk only when eligible", () => {
  expect(rewriteRtkCommand("git status")).toBe("rtk git status");
  expect(rewriteRtkCommand("rtk git status")).toBe("rtk git status");
  expect(rewriteRtkCommand("echo hello")).toBe("echo hello");
});

test("shouldRewriteWithRtk skips long-running variants of supported commands", () => {
  expect(shouldRewriteWithRtk("tail --follow")).toBe(false);
  expect(shouldRewriteWithRtk("tail -f")).toBe(false);
  expect(shouldRewriteWithRtk("jest --watch")).toBe(false);
  expect(shouldRewriteWithRtk("vitest --watch")).toBe(false);
  expect(shouldRewriteWithRtk("playwright --watch")).toBe(false);
  expect(shouldRewriteWithRtk("bun --hot")).toBe(false);
  expect(shouldRewriteWithRtk("npm run dev-server")).toBe(false);
  expect(shouldRewriteWithRtk("bun run dev")).toBe(false);
  expect(rewriteRtkCommand("tail --follow")).toBe("tail --follow");
  expect(rewriteRtkCommand("jest --watch")).toBe("jest --watch");
});

test("shouldRewriteWithRtk still rewrites one-shot commands", () => {
  expect(shouldRewriteWithRtk("ls")).toBe(true);
  expect(shouldRewriteWithRtk("git status")).toBe(true);
  expect(shouldRewriteWithRtk("tail -n 20 app.log")).toBe(true);
  expect(shouldRewriteWithRtk("jest")).toBe(true);
});

test("shouldRewriteWithRtk skips long-running variants of extended heads", () => {
  expect(shouldRewriteWithRtk("kubectl logs -f app")).toBe(false);
  expect(shouldRewriteWithRtk("kubectl logs --follow")).toBe(false);
  // Without a follow flag kubectl logs exits — safe to wrap.
  expect(shouldRewriteWithRtk("kubectl logs app")).toBe(true);
  expect(shouldRewriteWithRtk("docker logs -f web")).toBe(false);
  expect(shouldRewriteWithRtk("docker compose up")).toBe(false);
  expect(shouldRewriteWithRtk("docker compose -f dev.yml up")).toBe(false);
  expect(shouldRewriteWithRtk("tsc --watch")).toBe(false);
  expect(shouldRewriteWithRtk("cargo watch -x test")).toBe(false);
  expect(shouldRewriteWithRtk("eslint --watch src")).toBe(false);
  // Non-following docker compose builds are still wrapped.
  expect(shouldRewriteWithRtk("docker compose build")).toBe(true);
  expect(shouldRewriteWithRtk("kubectl get pods")).toBe(true);
});

test("isRtkAvailable caches the PATH probe result", () => {
  const { __resetRtkAvailabilityForTests, isRtkAvailable } = require("../src/extensions/rtk/index.ts") as typeof import("../src/extensions/rtk/index.ts");
  try {
    // bun itself is definitely on PATH.
    expect(isRtkAvailable("bun")).toBe(true);
    expect(isRtkAvailable("bun")).toBe(true); // cached — no second probe
    expect(isRtkAvailable("definitely-not-a-real-binary-xyz")).toBe(false);
  } finally {
    __resetRtkAvailabilityForTests();
  }
});
