---
id: password-hashing
title: Password Hashing
sources:
  - src/server/auth/password.ts
concepts:
  - id: adaptive-hashing
    name: Adaptive hashing with a per-user salt and tunable cost
rationale:
  - decision: Use an adaptive hash with a per-user salt
    why: Slows brute force and defeats rainbow tables
    provenance: inferred
---

# Password Hashing

## Abstract

How local passwords are stored safely.

## Introduction

Passwords must never be recoverable from the store.

## Related Work

A verified password establishes a [Session Management](../session-management/) session.

## Description

Adaptive hashing with a per-user salt and a tunable work factor.

## Rationale

Adaptive cost lets defense scale with hardware.

## Conclusion

The last line of defense for local credentials.
