---
id: sharing
title: Sharing
sources:
  - src/server/docs/sharing.ts
concepts:
  - id: capability-links
    name: Capability links grant scoped access without an account
  - id: role-checks
    name: Role checks resolved per request against the session
rationale:
  - decision: Grant access via capability links and per-request role checks
    why: Supports both account-based and link-based sharing uniformly
    provenance: inferred
---

# Sharing

## Abstract

Who may see or edit a document.

## Introduction

Documents are collaborative; access must be explicit and revocable.

## Related Work

Role checks run against the [Session Management](../../auth/session-management/)
identity and operate over the [Document Model](../document-model/).

## Description

Capability links plus per-request role checks.

## Rationale

Uniform checks cover both account and link sharing.

## Conclusion

The access-control layer of the documents province.
