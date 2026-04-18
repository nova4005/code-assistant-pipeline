Generate tests for the following Next.js code using Jest and React Testing Library (for components) or direct unit tests (for API routes/server actions).

Guidelines:
- Use `describe` / `it` blocks with clear, descriptive names
- For components: use `render()`, `screen`, `userEvent`, `waitFor` from @testing-library/react
- Use `getByRole`, `getByLabelText`, `getByText` — prefer accessible queries
- Mock `next/navigation` (`useRouter`, `useSearchParams`, `usePathname`)
- Mock `next/image` and `next/link` as needed
- For API routes: test with `NextRequest` and assert `NextResponse` status/body
- For Server Actions: test the function directly, mock database/external calls
- Mock `fetch` calls with `jest.fn()` or `msw`
- Test loading states, error states, and empty states
- Test form submissions, validation feedback, and redirects
- Include edge cases: unauthenticated users, missing data, network errors

Return ONLY the test file in a markdown code block. Do not include explanations outside the code block.
