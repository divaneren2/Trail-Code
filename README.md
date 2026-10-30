<div align="center">

# ⚡ trail-laravel

### The Self-Learning Context Layer & AST Engine Optimized for Laravel Codebases

**A specialized, production-ready fork of official [Trail-Code](https://github.com/trailhq/Trail-Code) (v0.28.0) by TrailHQ, built specifically for modern Laravel architecture.**

<p align="center">
  <img src="https://img.shields.io/badge/PHP-Laravel%2010%20%26%2011-FF2D20?style=for-the-badge&logo=laravel&logoColor=white" />
  <img src="https://img.shields.io/badge/CLI-trail--laravel-4F46E5?style=for-the-badge&logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/AST-Tree--Sitter-00ADD8?style=for-the-badge" />
  <img src="https://img.shields.io/badge/License-MIT-20C997?style=for-the-badge" />
</p>

```bash
# Global installation / usage
npm install -g trail-laravel
# Inside your Laravel project:
trail-laravel init
trail-laravel build
```

</div>

---

## 📌 Why `trail-laravel`? The Problem with Official Trail in Laravel

The official [Trail-Code](https://github.com/trailhq/Trail-Code) is a remarkable context engine for AI coding agents (Claude Code, Cursor, Gemini CLI, Google Antigravity, OpenCode, Codex). It parses repositories using tree-sitter into an AST graph of definitions, callers, and team learnings.

However, standard tree-sitter PHP grammars were designed for classic OOP codebases: they search strictly for traditional `class`, `interface`, `trait`, and `function` declarations. 

**In modern Laravel applications, the most critical application logic lives outside standard OOP declarations:**

| Laravel File Category | What it Contains | Official Trail-Code Output | `trail-laravel` Output |
| :--- | :--- | :--- | :--- |
| **`config/*.php`** | Flat & nested `return [...]` array expressions (`auth`, `database`, `mail`, etc.) | ⚠️ `_No extracted symbols in this file._` | ✅ **Full Nested Config AST Tree** (`auth.defaults.guard`, `database.connections.mysql.host`) |
| **`routes/*.php`** | Fluent chained method calls (`Route::get()`, `Route::prefix()->group()`, `Route::resource()`) | ⚠️ Anonymous `{closure} · function` (No URLs, no verbs, no names) | ✅ **Exact HTTP Verbs, Prefixes, Route Names & Controller Links** (`RESOURCE /app/reports` → `ReportController`) |
| **`resources/views/**/*.blade.php`** | Components (`<x-layout>`), slots (`<x-slot>`), `@extends`, `@include`, Livewire & Alpine | ⚠️ `_No extracted symbols in this file._` | ✅ **Component Definitions & Usages, Layouts, Slots, Directives & `@vite` Asset Links** |
| **`database/migrations/*.php`** | `Schema::create('posts', ...)`, column definitions, foreign keys | ⚠️ `{anonymous} · class`, `{closure}` (No table names or columns) | ✅ **Table Schemas (`table: posts`), Column Specs, and Foreign-Key Graph Edges** |
| **`bootstrap/providers.php` & `app.php`** | ServiceProvider array, `withRouting()`, `withMiddleware()`, `withExceptions()` | ⚠️ `_No extracted symbols in this file._` | ✅ **Registered Service Providers (`service-provider: AppServiceProvider`) & Pipeline Nodes** |
| **`routes/console.php`** | `Artisan::command('inspire', ...)->purpose(...)` | ⚠️ `{closure} · function` | ✅ **Artisan Console Endpoints (`command: inspire` + descriptions)** |
| **Eloquent Models (`app/Models/`)** | `hasMany`, `belongsTo`, `belongsToMany` relations, `$table`, `$fillable` | ⚠️ Methods without relation targets | ✅ **Enriched Signatures (`category(): BelongsTo → BlogCategory`) + Model-to-Model `calls` Edges** |

Without `trail-laravel`, an AI agent working on a Laravel codebase is blind to your routes, config, blade templates, database schemas, and Eloquent relationships, forcing it to fall back to expensive, slow raw file grepping.

---

## 📊 Real-World Benchmarks & Verification

We tested `trail-laravel` side-by-side with official `Trail-Code` across large-scale real-world production Laravel projects:

### 1. `finance` Project (Modular Enterprise Laravel Application)
* **Official Trail:** 12,457 nodes, 21,860 edges. **177 files** had `_No extracted symbols in this file._`.
* **trail-laravel:** **14,328 nodes, 23,994 edges** (**+1,871 new nodes, +2,134 new edges**).
  * **1,113** Blade template component & directive symbols extracted.
  * **109** Route & Artisan endpoints extracted (up from 0).
  * **71** Database table schemas & foreign key edges extracted.
  * **574** Configuration constants mapped.
  * Empty files dropped from 177 to just 13 (a **93% reduction**).

### 2. `natures-guuru` Project (Laravel 11 + React Modular Architecture)
* **Official Trail:** 611 nodes, 985 edges.
* **trail-laravel:** **1,266 nodes, 1,795 edges** (**+%107 Node Expansion**).
* **Agent Query Token Savings:** **86% – 95%** token savings across queries (e.g. `trail-laravel callers FrontendReportController` surfaces all 4 route call sites in 232 tokens vs. 4,674 tokens to re-read files).

---

## 🚀 Key Features in `trail-laravel`

### 1. Route-to-Controller Graph Wiring
Unwinds complex Laravel routing pipelines, including prefixes, nested route groups, resource controllers, and route names:
```bash
trail-laravel callers FrontendReportController
```
```text
FrontendReportController · class · app/Http/Controllers/FrontendReportController.php:L15-L285
  calls ← GET /app/reports/{report}/download/docx (reports.download.docx) (routes/web.php:L62)
  calls ← GET /app/reports/{report}/download/pdf (reports.download.pdf) (routes/web.php:L61)
  calls ← GET /app/reports/{report}/download/xlsx (reports.download.xlsx) (routes/web.php:L63)
  calls ← RESOURCE /app/reports (routes/web.php:L60)
```

### 2. Database Schema & Foreign-Key Dependency Graph
Parses `Schema::create` and `$table->foreignId('...')->constrained('...')` to connect database tables:
```bash
trail-laravel callers "table: blog_categories"
```
```text
table: blog_categories · type · Modules/Blog/database/migrations/2026_10_12_create_blog_tables.php:L14-L24
  calls ← BlogCategory (Modules/Blog/app/Models/BlogCategory.php:L8-L38)
  calls ← table: blog_posts (Modules/Blog/database/migrations/2026_10_12_create_blog_tables.php:L26-L54)
```

### 3. Eloquent Model Relationships
Automatically inspects return statements and return types (`BelongsTo`, `HasMany`, `BelongsToMany`, `HasOne`, `MorphTo`):
```bash
trail-laravel callers BlogCategory
```
```text
BlogCategory · class · Modules/Blog/app/Models/BlogCategory.php:L8-L38
  calls ← category (Modules/Blog/app/Models/BlogPost.php:L46-L49)
      48: return $this->belongsTo(BlogCategory::class, 'category_id');
```

### 4. Deep Blade Template Extraction
Indexes component tags (`<x-header />`), named slots (`<x-slot:actions>`), layout inheritance (`@extends`), stack pushes (`@push`), `@include`, Livewire components (`<livewire:cart />`), and `@vite(['...'])` assets.

### 5. Collision-Free CLI & MCP Integration
* Global binary named **`trail-laravel`** ensures no naming collision if official `trail` is also installed.
* Auto-generated `AGENTS.md`, `GEMINI.md`, and `.cursor/rules/` instruct agents to invoke `trail-laravel`.
* MCP Server configurations automatically wire `{ command: "trail-laravel", args: ["mcp"] }` for IDEs (Google Antigravity, Gemini CLI, Cursor, Claude Code).

---

## 🛠️ CLI Quick Reference

```bash
# Initialize trail-laravel in your Laravel project
trail-laravel init

# Build or refresh the code map (deterministic, $0, no API key)
trail-laravel build

# Inspect the status of your context graph
trail-laravel status

# Search context before opening source files
trail-laravel ask "where is blog_posts table created" --source

# Check who calls or depends on a symbol (Controller, Model, Table, Route)
trail-laravel callers BlogCategory
trail-laravel callers "table: blog_posts"

# Outgoing call trace (what does this symbol call?)
trail-laravel callers BlogPost --direction out

# Token-budgeted API surface overview
trail-laravel skeleton app/Http/Controllers/UserController.php

# Project orientation (clusters, hubs, hotspots)
trail-laravel map
```

---

## 📦 Project Structure

```text
.trail/
├── cache/            # Generated AST context graph (INDEX.md, node markdown files)
│   ├── app/
│   ├── config/
│   ├── database/
│   ├── routes/
│   └── resources/
└── learnings/        # Markdown files capturing decisions & learnings shared with your team
```

---

## 🤝 Attribution & Upstream

`trail-laravel` is an open-source enhancement built upon the foundation of [Trail-Code](https://github.com/trailhq/Trail-Code) (created by [TrailHQ](https://trailhq.com)). We are deeply grateful to the TrailHQ team for creating the pioneering code map and learnings layer for AI coding agents.

This project is licensed under the [MIT License](LICENSE).
