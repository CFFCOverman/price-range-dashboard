# Private and licensed repository content

The files under `Assets/` are data snapshots exported from FactSet. Treat them
as private, licensed content. Keeping this repository private does not grant a
right to redistribute the data and does not replace the FactSet agreement that
applies to the account or organization.

The fetcher source code and `fetcher/tickers.txt` do not contain exported market
data, login credentials, cookies, or browser profiles. Local browser state,
diagnostic logs, and export inboxes remain ignored by Git.

## Before making the repository public

1. Do not merely delete or untrack `Assets/`: old data remains in Git history.
2. Prefer creating a new clean public repository from a working tree with
   `Assets/` excluded, or rewrite the full Git history before changing access.
3. Confirm that no release artifact, tag, branch, cache, or large-file store
   still contains FactSet exports.
4. Re-check the applicable FactSet contract and any third-party supplier terms.

To stop tracking future changes while the repository remains private, restore
`Assets/` as an ignored path and remove it from the Git index. This only affects
future commits; it is not sufficient preparation for public release.
