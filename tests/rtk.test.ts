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
