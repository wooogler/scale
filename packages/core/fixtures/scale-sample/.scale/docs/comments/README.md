---
id: comments
title: Comments
sources:
  - src/server/docs/comments.ts
concepts:
  - id: anchored-threads
    name: Comment threads anchored to a block range
rationale:
  - decision: Anchor threads to block ranges rather than character offsets
    why: Anchors survive edits to surrounding content
    provenance: inferred
---

# Comments

## Abstract

Threaded discussion attached to document content.

## Introduction

Reviewers need to discuss specific parts of a document.

## Related Work

Comments anchor to nodes of the [Document Model](../document-model/).

## Description

Threads anchored to block ranges so they survive edits.

## Rationale

Block-range anchors are robust to surrounding edits.

## Conclusion

The discussion layer over documents.
