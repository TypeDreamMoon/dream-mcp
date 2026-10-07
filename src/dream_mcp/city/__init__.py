"""DreamCity: cities written as `.dct`, built by its own driver.

DreamCity has no editor bridge, so there is nothing to route: every request is the cold
path, `Tools/dcc.ps1`, and the driver itself refuses while an editor has the project open
(a second process on the same project would fight the first for its packages). What this
adds over the bare driver is the report: `dcc.ps1 verify` and `compile -Report` write every
diagnostic as JSON with its file, line and column, and that is read here instead of
scraping the log.
"""
