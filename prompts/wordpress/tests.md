Generate tests for the following WordPress code using PHPUnit and Brain Monkey (for hooks/filters).

Guidelines:
- Use PHPUnit `TestCase` with `Brain\Monkey\setUp()` / `tearDown()`
- Test action/filter hooks with `has_action()`, `has_filter()`, `expect_applied()`
- Mock WordPress functions: `get_option()`, `update_option()`, `get_post()`, `wp_remote_get()`
- Test shortcode output with `do_shortcode()`
- Test REST API endpoints: register routes, test `permission_callback`, assert responses
- Test AJAX handlers: set `$_POST`/`$_GET`, mock `wp_verify_nonce()`, `check_ajax_referer()`
- Test custom post types and taxonomies registration
- Test admin pages and settings with capability checks
- Mock `$wpdb` for database query tests
- Include edge cases: missing options, invalid post IDs, unauthorized users, empty arrays

Return ONLY the test file in a markdown code block. Do not include explanations outside the code block.
