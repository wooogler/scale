---
id: oauth-login
title: OAuth Login
sources:
  - src/server/auth/oauth.ts
concepts:
  - id: authorization-code-flow
    name: Authorization-code flow with PKCE
  - id: provider-linking
    name: Linking an external provider identity to a local account
rationale:
  - decision: Use the authorization-code flow with PKCE
    why: Public clients cannot keep a secret; PKCE protects the exchange
    provenance: inferred
---

# OAuth Login

## Abstract

Sign-in via external identity providers.

## Introduction

Users prefer not to manage another password.

## Related Work

A successful login hands off to [Session Management](../session-management/).

## Description

Runs the authorization-code flow, then provisions or links a local account.

## Rationale

PKCE protects the code exchange for public clients.

## Conclusion

The primary entry point into an authenticated session.
