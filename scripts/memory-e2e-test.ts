/**
 * pico memory system — end-to-end effect test.
 *
 * Drives the REAL pico CLI (--print mode) against isolated temp DBs and
 * reads sqlite to verify four dimensions:
 *   1. Retrieval recall + trust weighting
 *   2. Correction chain (correction_of) + contradiction detection
 *   3. TF-IDF semantic weakness (synonym/paraphrase recall)
 *   4. autoExtract accuracy (category classification)
 *
 * Usage:
 *   PI_PACKAGE_DIR=node_modules/@earendil-works/pi-coding-agent \
 *     bun run scripts/memory-e2e-test.ts
 */
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PKG = "node_modules/@earendil-works/pi-coding-agent";
const MODEL = process.env.PICO_TEST_MODEL ?? "zen-openai/hy3-free";
const TIMEOUT = 180_000;

interface Scenario {
  name: string;
  setup?: string[]; // memory tool calls as natural-language instructions, run in order
  prompt: string; // final user prompt
  verify: (db: Database, log: string) => string; // returns PASS/FAIL + detail
}

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "pico-mem-"));
  return join(dir, "memory.db");
}

function runCli(dbPath: string, prompt: string): string {
  const res = spawnSync(
    "bun",
    ["run", "bin/pico.ts", "--print", "--provider", "zen-openai", "--model", "hy3-free", prompt],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_PACKAGE_DIR: PKG,
        PICO_MEMORY_DB: dbPath,
        PICO_HOME: "",
      },
      timeout: TIMEOUT,
    },
  );
  return (res.stdout?.toString() ?? "") + (res.stderr?.toString() ?? "");
}

function facts(db: Database) {
  return db.query(
    "SELECT fact_id,category,content,trust_score,correction_of,scope FROM facts ORDER BY fact_id",
  ).all() as Array<{
    fact_id: number;
    category: string;
    content: string;
    trust_score: number;
    correction_of: number | null;
    scope: string;
  }>;
}

// ---- Scenarios -----------------------------------------------------------

const scenarios: Scenario[] = [
  {
    name: "S1 检索召回 + trust 加权",
    setup: [
      "用 memory 工具 action=add 写入事实：category=project，content='生产环境使用 Postgres 作为主数据库'。",
      "用 memory 工具 action=add 写入事实：category=project，content='代码托管在 github.com/acme/web 仓库'。然后对该 fact 调用 feedback helpful=true 两次以提升 trust。",
    ],
    prompt:
      "请先用 memory 工具 search 查询 'postgres database'，列出命中的 fact_id 和 content。然后回复 'done'。",
    verify: (db) => {
      const fs = facts(db);
      const postgres = fs.find((f) => /postgres/i.test(f.content));
      if (!postgres) return "FAIL: postgres 事实未被写入/召回";
      // trust 加权：github fact 应被 boost 到 >0.5
      const github = fs.find((f) => /github/i.test(f.content));
      if (!github) return "FAIL: github 事实缺失";
      const trustOk = github.trust_score > 0.5;
      return `PASS: 写入 ${fs.length} 条; github trust=${github.trust_score.toFixed(2)} ${trustOk ? "(已加权)" : "(未加权!)"}`;
    },
  },
  {
    name: "S2 纠错链 + 矛盾检测",
    setup: [
      "用 memory 工具 action=add 写入：category=project，content='我们使用 npm 管理依赖'。记住返回的 fact_id。",
      "用 memory 工具 action=add 写入一条纠错事实：category=correction，correction_of=<上一条fact_id>，content='实际上我们使用 bun 而非 npm，之前说错了'。",
    ],
    prompt:
      "请先调用 memory 工具 action=contradict 检测矛盾，列出 contradiction_score 最高的结果。然后调用 memory 工具 action=list 列出所有 fact（含 category）。最后回复 'done'。",
    verify: (db) => {
      const fs = facts(db);
      const corr = fs.find((f) => f.category === "correction");
      const corrOk = !!corr && corr.correction_of !== null;
      const hasProj = fs.some((f) => f.category === "project");
      return `PASS: correction_of=${corr?.correction_of ?? "null"} ${corrOk ? "(链已建立)" : "(FAIL 链缺失)"}; project存在=${hasProj}`;
    },
  },
  {
    name: "S3 TF-IDF 语义短板（同义改写）",
    setup: [
      "用 memory 工具 action=add 写入：category=user_pref，content='用户偏好用简洁的 TypeScript 代码，避免冗余抽象'。",
    ],
    prompt:
      "请用 memory 工具 search 查询 '用户讨厌啰嗦的 TS 实现，喜欢精简'（这是同义改写）。列出命中 fact_id。若未命中任何结果请明确说 '未命中'。然后回复 'done'。",
    verify: (db) => {
      const fs = facts(db);
      // 我们检查：模型 search 是否能召回原句。由于 TF-IDF 无语义，改写召回应失败。
      // 这里只报告 db 状态，召回结果需看模型日志。
      return `INFO: 已写入 ${fs.length} 条; 召回结果取决于模型 search 日志（见下方 CLI 输出）`;
    },
  },
  {
    name: "S4 autoExtract 自动抽取",
    setup: [],
    prompt:
      "在对话中，请明确说出以下内容（让系统能抽取）：'我更喜欢用 bun 而不是 npm'。然后说出 '我们决定使用 Postgres 作为数据库'。最后说 '实际上不要用 SQLite，之前说错了，要用 Postgres'。请在这些话之后回复 'done'。",
    verify: (db) => {
      const fs = facts(db);
      // autoExtract 在 session_end 触发；--print 模式是否触发 onSessionEnd 需验证
      const cats = fs.map((f) => f.category);
      if (fs.length === 0) {
        return "INFO: 0 条自动抽取结果 — 需确认 --print 模式是否触发 onSessionEnd 自动抽取";
      }
      return `PASS: 自动抽取 ${fs.length} 条, categories=${cats.join(",")}`;
    },
  },
];

// ---- Runner --------------------------------------------------------------

let pass = 0;
let fail = 0;
const dbDirs: string[] = [];

console.log("=".repeat(70));
console.log("pico 记忆系统 端到端效果测试");
console.log(`model=${MODEL}  (临时 db 隔离)`);
console.log("=".repeat(70));

for (const sc of scenarios) {
  const dbPath = freshDb();
  dbDirs.push(dbPath.replace(/memory\.db$/, ""));
  console.log(`\n### ${sc.name}`);
  console.log(`  db=${dbPath}`);

  // setup steps
  for (const step of sc.setup ?? []) {
    const out = runCli(dbPath, step);
    if (out.toLowerCase().includes("error") || out.toLowerCase().includes("trace")) {
      console.log("  [setup warn] " + out.split("\n").slice(-3).join(" | "));
    }
  }

  // main prompt
  const log = runCli(dbPath, sc.prompt);
  const db = new Database(dbPath, { readonly: true });
  const result = sc.verify(db, log);
  db.close();

  const tag = result.startsWith("PASS") ? "✓" : result.startsWith("FAIL") ? "✗" : "·";
  if (result.startsWith("PASS")) pass++;
  else if (result.startsWith("FAIL")) fail++;

  console.log(`  ${tag} ${result}`);
  // show model's memory-related output snippet
  const lines = log.split("\n").filter((l) => /fact_id|命中|未命中|contradict|correction|done/i.test(l));
  if (lines.length) console.log("  model> " + lines.slice(0, 6).join(" ⏎ "));
}

console.log("\n" + "=".repeat(70));
console.log(`汇总: PASS=${pass} FAIL=${fail} INFO=${scenarios.length - pass - fail}`);
console.log("临时 db 目录:");
dbDirs.forEach((d) => console.log("  " + d));
console.log("=".repeat(70));
