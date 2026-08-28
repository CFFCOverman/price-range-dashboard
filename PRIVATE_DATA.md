# Private and licensed repository content

The files under `Assets/` are data snapshots exported from FactSet. They are
kept local and ignored by Git. Treat them as private, licensed content. Keeping
a repository private does not grant a right to redistribute the data and does
not replace the FactSet agreement that applies to the account or organization.

The fetcher source code and `fetcher/tickers.txt` do not contain exported market
data, login credentials, cookies, or browser profiles. Local browser state,
diagnostic logs, and export inboxes remain ignored by Git.

## Before making the repository public

1. Confirm that `Assets/` is absent from the current tree and Git history.
2. Prefer creating a new clean public repository from a working tree with
   `Assets/` excluded, or rewrite the full Git history before changing access.
3. Confirm that no release artifact, tag, branch, cache, or large-file store
   still contains FactSet exports.
4. Re-check the applicable FactSet contract and any third-party supplier terms.

The current ignore policy prevents future `Assets/` files from being added by a
normal `git add`. Because earlier local commits may have contained snapshots,
review or rewrite history before publishing this repository.
