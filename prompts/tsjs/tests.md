Generate tests for the following TypeScript/JavaScript code using Jest or Vitest.

Guidelines:
- Use `describe` / `it` blocks with clear, descriptive names
- Mock external dependencies with `jest.mock()` or `vi.mock()`
- Test async functions with `async/await` and proper error assertions
- Use `toThrow`, `rejects.toThrow` for error handling tests
- Test type narrowing and discriminated unions at runtime
- Mock file system (`fs`), HTTP (`fetch`/`axios`), and child processes
- Test pure functions with parameterized tests (`it.each` / `test.each`)
- Test class methods, including constructor validation and edge cases
- Include boundary tests: empty strings, null/undefined, large arrays, negative numbers
- Test event emitters, streams, and callback patterns
- Verify proper cleanup in teardown (timers, listeners, connections)

Return ONLY the test file in a markdown code block. Do not include explanations outside the code block.
