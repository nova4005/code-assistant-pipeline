Generate tests for the following Laravel code using Pest PHP (preferred) or PHPUnit.

Guidelines:
- Use `it()` / `test()` syntax (Pest) with descriptive names
- Use Laravel factories and `RefreshDatabase` trait for database tests
- Test Eloquent relationships, scopes, and accessors/mutators
- Mock external services with `Http::fake()`, `Queue::fake()`, `Mail::fake()`
- Test form requests / validation rules with `assertSessionHasErrors`
- Test API endpoints with `actingAs()`, `getJson()`, `postJson()`, assert status codes
- Test middleware, gates, and policies for authorization
- Test jobs, events, listeners, and notifications in isolation
- Use `assertDatabaseHas()` / `assertDatabaseMissing()` for persistence checks
- Include edge cases: empty inputs, invalid IDs, unauthorized users, duplicate records

Return ONLY the test file in a markdown code block. Do not include explanations outside the code block.
