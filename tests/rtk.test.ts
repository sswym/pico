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
