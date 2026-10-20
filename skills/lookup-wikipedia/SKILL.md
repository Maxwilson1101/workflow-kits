---
name: lookup-wikipedia
description: >
  Look up concepts in English Wikipedia when a question needs verification or
  essential background.
---

# Look up Wikipedia

Answer the current question first; look up terms only as needed.

1. Search with `wikipedia_search`.
2. Use `description` and `excerpt` to judge relevance, not as full evidence.
3. Fetch worthwhile candidates with `wikipedia_fetch`, passing `title`
   unchanged.
4. Read the returned `path` with native file tools, then explain what matters to
   the question.

If nothing fits, stop this lookup; a search miss does not prove nonexistence.
