# Existing App Onboarding (Node and Non-Node)

This document describes the current onboarding constraints for importing existing applications into VibesPlatform.

Status date: 2026-03-08

## Overview

The platform supports two runtime paths:

- Dockerfile-defined runtime (stack agnostic).
- Node fallback runtime (used only when no `Dockerfile` is present).

## Shared Runtime Contract (All Imported Apps)

Regardless of stack:

- App must run as a web service.
- App must bind to `0.0.0.0:$PORT` (`PORT` defaults to `3000` if unset).
- Health check endpoint is `/` and must return success (`2xx` or `3xx`).
- App runs as one container behind one HTTP Kubernetes Service + Ingress.
- Runtime resources are constrained by platform CPU/memory limits and startup/readiness probes.

## Node App Onboarding

Node apps can onboard in either mode:

- With a `Dockerfile`: platform builds and runs your Dockerfile as the source of truth.
- Without a `Dockerfile`: platform uses fallback Node runtime assumptions:
  - `node:20` base image
  - installs dependencies from lockfile/package manager
  - start command is `START_COMMAND` if provided, otherwise `npm start`

Recommended for predictable results:

- Include an explicit `Dockerfile`.
- Ensure start command is non-interactive.
- Ensure app listens on `PORT` and returns healthy status on `/`.

## Non-Node App Onboarding

Non-Node apps are supported when the repository includes a valid `Dockerfile`.

Current constraints:

- A `Dockerfile` is required. Without one, fallback is Node-only.
- Base image and build dependencies must be reachable during build.
- Private registries/private package artifacts are not supported by default unless platform-side build auth is added.
- App must still satisfy the shared runtime contract (`PORT`, `/` health, single HTTP container model).

## What Is Not Supported by Default

- Compose-style multi-service app topology in a single project deploy.
- Private build dependencies without registry/artifact auth integration.
- Apps that only bind to `localhost` or require interactive/dev-only startup.

## Pre-Onboarding Checklist

Before importing an existing app:

- Confirm app can run non-interactively in a container.
- Confirm app binds to `0.0.0.0:$PORT`.
- Confirm `GET /` returns `2xx`/`3xx`.
- For non-Node stacks, confirm repository includes a production-ready `Dockerfile`.
- Confirm all build dependencies are publicly reachable, or coordinate platform auth support first.
