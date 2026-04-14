## Before Implementing, Confirm the Approach

- **Stop and describe your planned approach in 2-3 sentences before making significant changes**, especially to core architecture, state management, or agent patterns.
- If the user has already explained the architecture, **restate your understanding** before coding to confirm alignment.
- **Do not assume fixed phase counts or agent-specific patterns** unless the user explicitly states them. Ask first.
- If the user interrupts or rejects your approach, **stop immediately, ask for clarification, and restart** — do not iterate on the same wrong direction.

## Testing Conventions

- **Run the full test suite after modifying core modules** (state management, controllers, workers, agent loop).
- **Mock state should be self-contained** — do not rely on shared mutable mock state between tests.
- **Avoid same-second assumptions** in test IDs or timestamps — use unique prefixes or UUIDs.
- **When writing tests for async/streaming behavior**, account for timing variability and signal type correctness.
- **After fixing bugs discovered during testing, re-run the suite** to confirm no regressions.
