# Task 1 Report: SDK v2 Protocol Tests

## Status

DONE_WITH_CONCERNS

## Changed Files

- `sdk/tests/sdk-protocol.test.js`

## Commit

`aaa27fd`

## Run Commands

```bash
npm --prefix sdk run test:sdk
```

## Test Result Summary

The SDK test run failed as expected.

Observed failure:

- `AssertionError [ERR_ASSERTION]: 1 !== 2`

This confirms the new v2 expectations are stricter than the current implementation.

## Concerns

- This task intentionally leaves the SDK implementation unchanged, so the test suite is expected to fail until the v2 protocol work lands in later tasks.
- No firmware or hardware validation was performed.

## Fix Report

- Command: `npm --prefix sdk run test:sdk`
- Result: expected to fail; will verify the first failing assertion after the fixture fix.
- Commit: `d1b4bea`
- Concerns: implementation may still fail on the current protocol constant/version mismatch; no hardware validation in this environment.
