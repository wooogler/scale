---
id: session-management
title: Session Management
sources:
  - src/server/auth/sessions.ts
  - src/server/middleware/session.ts
concepts:
  - id: server-side-sessions
    name: Server-side session store; the cookie carries only an opaque id
  - id: session-rotation
    name: Session rotation on privilege change
rationale:
  - decision: Sessions are server-side; the cookie is an opaque id
    why: Revocation must be immediate for shared-document access control
    alternatives: JWT-in-cookie (rejected — revocation complexity)
    provenance: inferred
---

# Session Management

## Abstract

How a signed-in identity is carried across requests without re-authenticating.

## Introduction

Every protected request needs to know who is asking. This component owns that.

## Related Work

Sessions are created after a successful [OAuth Login](../oauth-login/) and gate
access decisions in [Sharing](../../docs/sharing/).

## Description

A server-side store keyed by an opaque id; the browser cookie carries only that id.

## Rationale

Server-side state keeps revocation immediate.

## Conclusion

The backbone of identity continuity in the realm.
