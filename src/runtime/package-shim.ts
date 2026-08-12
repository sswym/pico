/**
 * Package shim — source-mode brand override for upstream pi.
 *
 * Upstream derives APP_NAME from `package.json`'s `piConfig.name` in the
 * package directory resolved via getPackageDir() (PI_PACKAGE_DIR env takes
 * precedence). In compiled-binary mode pico's generated package.json carries
 * `piConfig.name: "pico"`, so the TUI brands itself pico and prints pico
 * resume commands on quit. In source mode PI_PACKAGE_DIR points at the real
 * upstream package, whose piConfig.name is unset — APP_NAME falls back to
 * "pi", and the quit screen prints `pi --session-dir … --session …`, which
 * does not exist on machines that only installed pico.
 *
 * ensurePackageShim() builds a tiny overlay directory under PICO_HOME:
 *   <picoHome>/pkg/
 *   ├── package.json   full copy of upstream package.json + piConfig.name="pico"
 *   ├── dist ->        symlink to upstream dist (themes, assets, export-html)
 *   ├── docs ->        symlink (docs dir used by upstream)
 *   ├── examples ->    symlink
 *   ├── README.md ->   symlink
 *   └── CHANGELOG.md -> symlink
 *
 * All other package-dir consumers (themes, bundled assets, README, CHANGELOG,
 * export-html) resolve through the symlinks, so behaviour is identical to
 * pointing PI_PACKAGE_DIR at the real package — only the brand changes.
 * The overlay is rebuilt atomically; concurrent pico processes (main + child
 * subagents) writing the same content are harmless (last rename wins).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Entries symlinked (not copied) from the upstream package. */
const SHIM_SYMLINK_ENTRIES = ["dist", "docs", "examples", "README.md", "CHANGELOG.md"] as const;

/**
 * Ensure the brand overlay exists under <picoHome>/pkg and return its path.
 * Returns null on any failure (missing upstream package, unwritable home,
 * symlink failure) — callers then fall back to the real package dir and the
 * upstream "pi" brand, never crashing startup over cosmetics.
 */
export function ensurePackageShim(picoHome: string, upstreamPackageDir: string): string | null {
	const upstreamPkgPath = join(upstreamPackageDir, "package.json");
	if (!existsSync(upstreamPkgPath)) return null;

	let upstreamPkg: Record<string, unknown>;
	try {
		upstreamPkg = JSON.parse(readFileSync(upstreamPkgPath, "utf8"));
	} catch {
		return null;
	}
	if (typeof upstreamPkg !== "object" || upstreamPkg === null) return null;

	const shimDir = join(picoHome, "pkg");
	try {
		mkdirSync(shimDir, { recursive: true });
	} catch {
		return null;
	}

	const shimPkg = {
		...upstreamPkg,
		// configDir 必须与编译模式 scripts/build.ts 生成的 package.json 一致
		// （piConfig.configDir: ".pico"）。缺失时上游 CONFIG_DIR_NAME 回退
		// ".pi"，源码模式的项目级配置（.pi/settings.json）与编译模式
		// （.pico/settings.json）分裂，用户会困惑该建哪个文件。
		piConfig: { ...((upstreamPkg.piConfig as object | undefined) ?? {}), name: "pico", configDir: ".pico" },
	};

	// Atomic write: tmp + rename so a concurrent process never reads a
	// half-written package.json. Identical content makes races benign.
	const shimPkgPath = join(shimDir, "package.json");
	const tmpPath = join(shimDir, `package.json.tmp-${process.pid}`);
	try {
		writeFileSync(tmpPath, `${JSON.stringify(shimPkg, null, 2)}\n`);
		renameSync(tmpPath, shimPkgPath);
	} catch {
		try {
			unlinkSync(tmpPath);
		} catch {}
		return null;
	}

	// Symlinks are best-effort: a missing dist degrades brand/asset lookup,
	// so failure here falls back to the real package dir instead.
	for (const entry of SHIM_SYMLINK_ENTRIES) {
		const target = join(upstreamPackageDir, entry);
		const link = join(shimDir, entry);
		try {
			if (existsSync(link)) {
				// Keep correct links; replace stale links and regular files
				// blocking the slot (unlink handles both).
				if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) continue;
				unlinkSync(link);
			}
			symlinkSync(target, link);
		} catch {
			// Broken/blocked link for a non-critical entry — keep going.
		}
	}

	// dist is critical (themes/assets resolution): require a real link to
	// the upstream dist, not merely some file at the slot.
	let distLinked = false;
	try {
		distLinked = lstatSync(join(shimDir, "dist")).isSymbolicLink() &&
			readlinkSync(join(shimDir, "dist")) === join(upstreamPackageDir, "dist");
	} catch {}
	if (!distLinked) return null;
	return shimDir;
}
