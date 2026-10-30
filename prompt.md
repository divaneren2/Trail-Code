# Role & Objective
You are an expert TypeScript/Node.js systems engineer and tree-sitter/AST specialist. We are taking the official Trail-Code repository (https://github.com/trailhq/Trail-Code), forking/cloning it locally, and transforming it into a specialized, production-ready CLI tool named `trail-laravel` optimized for Laravel codebases.

The core issue in standard Trail-Code when applied to Laravel is that configuration files (`config/*.php`), route files (`routes/*.php`), and Blade templates (`resources/views/**/*.blade.php`) output "_No extracted symbols in this file._" because standard PHP tree-sitter parsers look strictly for classes/functions, ignoring flat return arrays, route bindings, and Blade markup.

Your task is to guide or perform the complete end-to-end setup, code modifications, and global CLI linking on our Linux (Pop!_OS) environment.

## Complete Implementation Workflow

### Step 1: Repository Setup & Naming
- Initialize the project structure from the Trail-Code base (or assume we are working in the cloned `trail-laravel` workspace).
- Update the `name` field in `package.json` to `"trail-laravel"`.
- Configure the binary mapping in `package.json` so the CLI executable is registered globally:
  ```json
  "bin": {
    "trail-laravel": "./dist/cli.js"
  }
Step 2: Implement Laravel-Specific Extractors (TypeScript)
Locate the file/language parsers and extractors in the codebase (under src/extractors/ or language handlers) and implement or extend extractors for the following file patterns:

Config Files (config/*.php):

Detect files in the config/ directory.

Parse top-level return array keys (e.g., return [ 'database' => [...] ]) and nested configuration keys, registering them as configuration symbols so they appear in the graph instead of showing "No symbols".

Route Files (routes/*.php):

Detect files in the routes/ directory (web.php, api.php, etc.).

Extract route definitions such as Route::get('/path', ...), Route::post(...), and route group prefixes as endpoint symbols.

Blade Template Files (resources/views/**/*.blade.php):

Detect .blade.php files.

Extract component usages (e.g., <x-component-name />), layout inheritance (@extends(...)), partial inclusions (@include(...)), and Livewire/Alpine bindings as template symbols.

Step 3: Update File Inclusion/Exclusion Rules
Ensure standard Laravel directories like vendor/, storage/, bootstrap/cache/, and node_modules/ are ignored by default via .trailignore or default config rules.

Ensure app/, config/, routes/, and resources/views/ are correctly targeted with their respective custom extractors.

Step 4: Build, Link & Verification Instructions
Run TypeScript compilation (npm run build) and fix any type errors.

Run npm link to register the CLI command globally as trail-laravel on Pop!_OS.

Provide a summary of how to test it inside any Laravel project using:

Bash
trail-laravel init
trail-laravel build

---

<FollowUp label="Antigravity IDE ile bu projeyi derleyip yerel testleri yaparken karşılaşabileceğimiz olası TypeScript hata tiplerini önceden inceleyelim mi?" query="Trail-Code kod tabanını TypeScript ile özelleştirirken karşılaşabileceğimiz olası tip (type) veya derleme hatalarını ve çözüm yollarını açıklar mısın?"/>