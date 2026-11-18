v1.2.3 — safe artwork cleanup, fresh log on start

- Fallback cleanup no longer deletes unrelated artwork: when the bot
  loses track of its fileId (e.g. restarted during a pause), it now
  deletes only artworks signed with the invisible bot signature
  (zero-width chars) or the legacy "now-playing" title. Personal
  illustrations without the signature are never touched.
- bot.log is truncated on every start from the launcher, so "Show log"
  always displays the fresh log of the current run instead of growing
  forever.
- Fixed: launcher "Check updates" (menu item 8) triggered the first-run
  wizard instead of checking for updates when SETUP_DONE was missing.
