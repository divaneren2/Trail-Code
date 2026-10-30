import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { walkDir } from "../dist/ingest/fs.js";

const tmpDir = join(process.cwd(), "test_laravel_repo_sandbox");
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {}

mkdirSync(join(tmpDir, "app", "Http", "Controllers"), { recursive: true });
mkdirSync(join(tmpDir, "config"), { recursive: true });
mkdirSync(join(tmpDir, "routes"), { recursive: true });
mkdirSync(join(tmpDir, "resources", "views"), { recursive: true });
mkdirSync(join(tmpDir, "storage", "framework", "views"), { recursive: true });
mkdirSync(join(tmpDir, "bootstrap", "cache"), { recursive: true });
mkdirSync(join(tmpDir, "vendor", "laravel", "framework"), { recursive: true });
mkdirSync(join(tmpDir, "node_modules", "package"), { recursive: true });

writeFileSync(join(tmpDir, "app", "Http", "Controllers", "UserController.php"), "<?php");
writeFileSync(join(tmpDir, "config", "app.php"), "<?php");
writeFileSync(join(tmpDir, "routes", "web.php"), "<?php");
writeFileSync(join(tmpDir, "resources", "views", "welcome.blade.php"), "<div>");
writeFileSync(join(tmpDir, "bootstrap", "app.php"), "<?php");

// Ignored files:
writeFileSync(join(tmpDir, "storage", "framework", "views", "cached.php"), "<?php");
writeFileSync(join(tmpDir, "bootstrap", "cache", "packages.php"), "<?php");
writeFileSync(join(tmpDir, "vendor", "laravel", "framework", "Kernel.php"), "<?php");
writeFileSync(join(tmpDir, "node_modules", "package", "index.js"), "console.log(1)");

// Custom .trailignore test:
writeFileSync(join(tmpDir, "resources", "views", "ignored_view.blade.php"), "<div>");
writeFileSync(join(tmpDir, ".trailignore"), "resources/views/ignored_view.blade.php\n");

const files = walkDir(tmpDir).map((f) => f.replace(tmpDir + "/", "").replace(/\\/g, "/"));
console.log("Walked files:", files);

assert(files.includes("app/Http/Controllers/UserController.php"), "Should include app controllers");
assert(files.includes("config/app.php"), "Should include config files");
assert(files.includes("routes/web.php"), "Should include routes");
assert(files.includes("resources/views/welcome.blade.php"), "Should include blade views");
assert(files.includes("bootstrap/app.php"), "Should include bootstrap/app.php");

assert(!files.some((f) => f.startsWith("storage/")), "storage/ MUST be ignored");
assert(!files.some((f) => f.startsWith("bootstrap/cache/")), "bootstrap/cache/ MUST be ignored");
assert(!files.some((f) => f.startsWith("vendor/")), "vendor/ MUST be ignored");
assert(!files.some((f) => f.startsWith("node_modules/")), "node_modules/ MUST be ignored");
assert(!files.includes("resources/views/ignored_view.blade.php"), ".trailignore rule MUST be ignored");

rmSync(tmpDir, { recursive: true, force: true });
console.log("✓ All Laravel exclusion/inclusion tests PASSED successfully!");

