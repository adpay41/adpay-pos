# 0008 — Expo (SDK 57) as the React Native toolchain for register and merchant

- Status: Accepted
- Date: 2026-09-23
- Relates to: spec Decisions → Monorepo, Register

## Context

The spec fixes React Native for `apps/register` (Android only, kiosk, dual screen, a small Kotlin
module) and `apps/merchant` (iOS + Android). It does not name a toolchain. The founder also wants to
see both apps early, on a Windows laptop, before any hardware arrives.

## Decision

Both apps use **Expo SDK 57 (React Native 0.86)** with the default Metro bundler.

- **Web target for development**: `pnpm dev` serves both apps in the browser via react-native-web.
- **Native modules**: the register's Kotlin module (printer, drawer kick, HID scanner, and the
  customer display through the Android Presentation API) is written as an **Expo Module**, built
  with `expo prebuild` / a development build. Expo Go is not used for the register.
- **Kiosk and Device Owner** are Android manifest and device-policy settings; a config plugin
  applies them at prebuild. Nothing about Expo prevents running as the HOME launcher in lock-task mode.
- **Builds and OTA**: EAS is optional, not assumed. Local `gradle` builds work without an Expo
  account. The Esper-vs-own-OTA question stays open, as the spec says.

## Consequences

- One toolchain and one set of upgrade notes for both RN apps. Monorepo support (pnpm workspaces,
  a hoisted `node_modules`, see `.npmrc`) works without custom Metro config.
- `@adpay/shared` is consumed as TypeScript source by Metro, Next and the API alike.
- The customer screen can't be exercised on the web target; its layout is previewed in the register's
  side panel until the Presentation API module lands in step 2.

## Rejected

- **Bare React Native CLI**: the same native capability with more hand-maintained native project
  files, and no web target to show progress on.
