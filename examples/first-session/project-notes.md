# Demo project: reading list

This is fictional sample data for trying an AI assistant in LatticeTerm.

## Goal

A small reading-list app lets people save articles they want to read later.

## Feedback

- Saving the same URL twice creates two entries. Keep one entry per URL.
- After marking an article as read, it still appears in the unread filter.
- People cannot find old entries by title. Add title search after the first two problems are fixed.

## Expected behavior

- Saving an existing URL keeps the original entry and tells the user it is already saved.
- The unread filter contains only unread entries; the all-items view still includes read entries.
- Title search ignores letter case and shows an empty state when nothing matches.

## Open question

Should URL matching ignore tracking parameters? This needs a product decision before implementation.
