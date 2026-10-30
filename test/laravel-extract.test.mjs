import assert from "node:assert";
import { warmDepthGrammars } from "../dist/graph/depth-parser.js";
import { extractFile, languageOf, languageLabelOf } from "../dist/graph/extract.js";
import { isBladeFile, isLaravelConfigFile, isLaravelRouteFile } from "../dist/graph/laravel.js";

async function runTests() {
  console.log("Warming depth grammars...");
  await warmDepthGrammars(["php"]);

  console.log("\n--- Testing Path & Language Detection ---");
  assert.strictEqual(isBladeFile("resources/views/welcome.blade.php"), true);
  assert.strictEqual(isBladeFile("resources/views/partials/header.blade.php"), true);
  assert.strictEqual(isBladeFile("app/Http/Controllers/UserController.php"), false);

  assert.strictEqual(isLaravelConfigFile("config/app.php"), true);
  assert.strictEqual(isLaravelConfigFile("config/database.php"), true);
  assert.strictEqual(isLaravelConfigFile("app/Models/User.php"), false);

  assert.strictEqual(isLaravelRouteFile("routes/web.php"), true);
  assert.strictEqual(isLaravelRouteFile("routes/api.php"), true);
  assert.strictEqual(isLaravelRouteFile("routes/console.php"), true);

  assert.strictEqual(languageOf("resources/views/welcome.blade.php"), "php");
  assert.strictEqual(languageLabelOf("resources/views/welcome.blade.php"), "blade");

  console.log("✓ Path and language detection passed.");

  console.log("\n--- Testing Config Extractor (config/database.php) ---");
  const configSource = `<?php
return [
    'default' => env('DB_CONNECTION', 'sqlite'),
    'connections' => [
        'sqlite' => [
            'driver' => 'sqlite',
            'url' => env('DB_URL'),
            'database' => env('DB_DATABASE', database_path('database.sqlite')),
        ],
        'mysql' => [
            'driver' => 'mysql',
            'host' => env('DB_HOST', '127.0.0.1'),
        ],
    ],
    'providers' => [
        App\\Providers\\DatabaseServiceProvider::class,
    ],
];
`;
  const configResult = extractFile("config/database.php", configSource, "php");
  console.log(`Config extracted ${configResult.nodes.length} nodes and ${configResult.rawEdges.length} edges.`);
  assert(configResult.nodes.length > 1, "Should have extracted config symbols besides the file node");

  const configSymbolNames = configResult.nodes.map((n) => n.name);
  console.log("Extracted config symbols:", configSymbolNames);
  assert(configSymbolNames.includes("default"), "Should extract 'default'");
  assert(configSymbolNames.includes("connections"), "Should extract 'connections'");
  assert(configSymbolNames.includes("connections.sqlite"), "Should extract 'connections.sqlite'");
  assert(configSymbolNames.includes("connections.mysql"), "Should extract 'connections.mysql'");
  assert(configResult.nodes.some((n) => n.kind === "constant"), "Symbols should have kind 'constant'");

  // Check imports edge to DatabaseServiceProvider
  assert(
    configResult.rawEdges.some((e) => e.relation === "imports" && e.name === "DatabaseServiceProvider"),
    "Should have imports edge to DatabaseServiceProvider"
  );
  console.log("✓ Config extractor passed.");

  console.log("\n--- Testing Route Extractor (routes/web.php) ---");
  const routeSource = `<?php
use App\\Http\\Controllers\\ProfileController;
use App\\Http\\Controllers\\UserController;
use Illuminate\\Support\\Facades\\Route;

Route::get('/', function () {
    return view('welcome');
});

Route::post('/users', [UserController::class, 'store'])->name('users.store');

Route::prefix('admin')->middleware(['auth'])->group(function () {
    Route::get('/dashboard', [AdminController::class, 'index']);
    Route::resource('/photos', PhotoController::class);
});
`;
  const routeResult = extractFile("routes/web.php", routeSource, "php");
  console.log(`Routes extracted ${routeResult.nodes.length} nodes and ${routeResult.rawEdges.length} edges.`);
  assert(routeResult.nodes.length > 1, "Should have extracted route symbols besides file node");

  const routeNames = routeResult.nodes.map((n) => n.name);
  console.log("Extracted route symbols:", routeNames);
  assert(routeNames.some((n) => n.includes("GET /")), "Should extract GET /");
  assert(routeNames.some((n) => n.includes("POST /users (users.store)")), "Should extract POST /users (users.store)");
  assert(routeNames.some((n) => n.includes("admin/dashboard")), "Should extract nested admin/dashboard route");
  assert(routeNames.some((n) => n.includes("RESOURCE /admin/photos")), "Should extract RESOURCE /admin/photos");

  const endpoints = routeResult.nodes.filter((n) => n.kind === "endpoint");
  assert(endpoints.length >= 4, "Should have at least 4 endpoint symbols");

  // Check call edge to UserController
  assert(
    routeResult.rawEdges.some((e) => e.relation === "calls" && e.name === "UserController"),
    "Should have calls edge to UserController"
  );
  assert(
    routeResult.rawEdges.some((e) => e.relation === "calls" && e.name === "store"),
    "Should have calls edge to store method"
  );
  console.log("✓ Route extractor passed.");

  console.log("\n--- Testing Blade Extractor (resources/views/home.blade.php) ---");
  const bladeSource = `@extends('layouts.app')

@section('content')
    <x-alert type="warning" message="System maintenance" />
    <livewire:user-table :active="true" />
    <div x-data="{ open: false }" @click="open = !open">
        @include('partials.sidebar', ['open' => true])
    </div>
@endsection
`;
  const bladeResult = extractFile("resources/views/home.blade.php", bladeSource, "php");
  console.log(`Blade extracted ${bladeResult.nodes.length} nodes and ${bladeResult.rawEdges.length} edges.`);
  assert(bladeResult.nodes.length > 1, "Should have extracted Blade symbols besides file node");

  const bladeNames = bladeResult.nodes.map((n) => n.name);
  console.log("Extracted Blade symbols:", bladeNames);
  assert(bladeNames.includes("@extends('layouts.app')"), "Should extract @extends");
  assert(bladeNames.includes("<x-alert>"), "Should extract <x-alert>");
  assert(bladeNames.includes("<livewire:user-table>"), "Should extract <livewire:user-table>");
  assert(bladeNames.some((n) => n.startsWith("alpine:x-data")), "Should extract Alpine x-data");
  assert(bladeNames.includes("@include('partials.sidebar')"), "Should extract @include");

  assert(
    bladeResult.rawEdges.some((e) => e.relation === "extends" && e.name === "layouts.app"),
    "Should have extends edge"
  );
  assert(
    bladeResult.rawEdges.some((e) => e.relation === "calls" && e.name === "alert"),
    "Should have calls edge to component alert"
  );
  assert(
    bladeResult.rawEdges.some((e) => e.relation === "calls" && e.name === "user-table"),
    "Should have calls edge to livewire user-table"
  );
  assert(
    bladeResult.rawEdges.some((e) => e.relation === "imports" && e.name === "partials.sidebar"),
    "Should have imports edge to partials.sidebar"
  );
  console.log("✓ Blade extractor passed.");

  console.log("\n--- Testing Migration Extractor (database/migrations/*.php) ---");
  const migrationSource = `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration {
    public function up(): void {
        Schema::create('categories', function (Blueprint $table) {
            $table->id();
            $table->string('name');
        });

        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('category_id')->constrained('categories');
            $table->string('title');
        });
    }
};
`;
  const migrationResult = extractFile("database/migrations/2026_01_01_create_posts_table.php", migrationSource, "php");
  console.log(`Migration extracted ${migrationResult.nodes.length} nodes and ${migrationResult.rawEdges.length} edges.`);
  const migrationNames = migrationResult.nodes.map((n) => n.name);
  console.log("Extracted migration symbols:", migrationNames);
  assert(migrationNames.includes("table: categories"), "Should extract table: categories");
  assert(migrationNames.includes("table: posts"), "Should extract table: posts");
  assert(
    migrationResult.rawEdges.some((e) => e.relation === "calls" && e.name === "table: categories"),
    "Should have foreign key edge from posts to table: categories"
  );
  console.log("✓ Migration extractor passed.");

  console.log("\n--- Testing Bootstrap Extractor (bootstrap/providers.php & app.php) ---");
  const providersSource = `<?php
use App\\Providers\\AppServiceProvider;
use Modules\\Blog\\Providers\\BlogServiceProvider;

return [
    AppServiceProvider::class,
    BlogServiceProvider::class,
];
`;
  const providersResult = extractFile("bootstrap/providers.php", providersSource, "php");
  const providerNames = providersResult.nodes.map((n) => n.name);
  console.log("Extracted providers:", providerNames);
  assert(providerNames.includes("service-provider: AppServiceProvider"), "Should extract AppServiceProvider");
  assert(providerNames.includes("service-provider: BlogServiceProvider"), "Should extract BlogServiceProvider");
  assert(
    providersResult.rawEdges.some((e) => e.relation === "imports" && e.name === "AppServiceProvider"),
    "Should import AppServiceProvider"
  );

  const bootstrapAppSource = `<?php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
    )
    ->withMiddleware(function () {})
    ->withExceptions(function () {})
    ->create();
`;
  const bootstrapAppResult = extractFile("bootstrap/app.php", bootstrapAppSource, "php");
  const bootstrapNames = bootstrapAppResult.nodes.map((n) => n.name);
  console.log("Extracted bootstrap app symbols:", bootstrapNames);
  assert(bootstrapNames.includes("bootstrap: withRouting"), "Should extract withRouting");
  assert(bootstrapNames.includes("bootstrap: withMiddleware"), "Should extract withMiddleware");
  assert(bootstrapNames.includes("bootstrap: withExceptions"), "Should extract withExceptions");
  console.log("✓ Bootstrap extractor passed.");

  console.log("\n--- Testing Artisan Console Extractor (routes/console.php) ---");
  const consoleSource = `<?php
use Illuminate\\Support\\Facades\\Artisan;

Artisan::command('inspire', function () {
    $this->comment('Stay hungry');
})->purpose('Display an inspiring quote');
`;
  const consoleResult = extractFile("routes/console.php", consoleSource, "php");
  const consoleNames = consoleResult.nodes.map((n) => n.name);
  console.log("Extracted console symbols:", consoleNames);
  assert(consoleNames.includes("command: inspire"), "Should extract command: inspire");
  const inspireNode = consoleResult.nodes.find((n) => n.name === "command: inspire");
  assert(inspireNode?.signature?.includes("Display an inspiring quote"), "Signature should have purpose");
  console.log("✓ Artisan console extractor passed.");

  console.log("\n--- Testing Eloquent Model Extractor (app/Models/BlogPost.php) ---");
  const modelSource = `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Relations\\BelongsTo;

class BlogPost extends Model {
    protected $table = 'blog_posts';
    protected $fillable = ['title', 'slug'];

    public function category(): BelongsTo {
        return $this->belongsTo(BlogCategory::class);
    }
}
`;
  const modelResult = extractFile("app/Models/BlogPost.php", modelSource, "php");
  console.log(`Model extracted ${modelResult.nodes.length} nodes and ${modelResult.rawEdges.length} edges.`);
  const catMethod = modelResult.nodes.find((n) => n.name === "category");
  assert(catMethod, "Should extract category method");
  assert(catMethod.signature?.includes("→ BlogCategory"), "Signature should be enriched with target model");
  assert(
    modelResult.rawEdges.some((e) => e.relation === "calls" && e.name === "BlogCategory"),
    "Should have calls edge to BlogCategory"
  );
  assert(
    modelResult.rawEdges.some((e) => e.relation === "calls" && e.name === "table: blog_posts"),
    "Should have calls edge to table: blog_posts"
  );
  console.log("✓ Eloquent model extractor passed.");

  console.log("\nAll Laravel extraction unit tests PASSED successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
