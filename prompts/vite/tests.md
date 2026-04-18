Generate tests for the following Vite/React code using Vitest and React Testing Library.

Guidelines:
- Use `describe` / `it` blocks with clear, descriptive names
- For components: use `render()`, `screen`, `userEvent`, `waitFor` from @testing-library/react
- Use accessible queries: `getByRole`, `getByLabelText`, `getByText`
- Mock `import.meta.env` for environment variable tests
- Mock API calls with `vi.fn()` or `msw` (Mock Service Worker)
- Test React hooks with `renderHook()` from @testing-library/react
- Test form handling, validation, and submission
- Test routing with `MemoryRouter` from react-router-dom
- Test loading, error, and empty states
- Test responsive behavior and conditional rendering
- Include edge cases: missing props, empty data, rejected promises, rapid re-renders

Return ONLY the test file in a markdown code block. Do not include explanations outside the code block.
