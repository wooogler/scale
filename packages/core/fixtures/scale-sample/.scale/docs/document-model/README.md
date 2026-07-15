---
id: document-model
title: Document Model
sources:
  - src/server/docs/model.ts
concepts:
  - id: block-tree
    name: Documents are a tree of typed blocks
  - id: revision-log
    name: Every edit appends to an immutable revision log
rationale:
  - decision: Store documents as a block tree with an append-only revision log
    why: Enables fine-grained collaboration and full history
    provenance: inferred
---

# Document Model

## Abstract

The core data structure every documents feature builds on.

## Introduction

Collaboration needs a structured, versioned representation.

## Related Work

Access is mediated by [Sharing](../sharing/) and annotated by [Comments](../comments/).

## Description

A tree of typed blocks with an append-only revision log.

## Rationale

An append-only log preserves full history cheaply.

## Conclusion

The foundation of the documents province.
