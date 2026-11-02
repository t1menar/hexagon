# Adapter fixtures

`<name>.jsonl` is what the CLI prints on stdout; `<name>.expect.json` says what the adapter must make of it
(`emits`, `model`, `handle`, `usage`, or for a failing CLI `exit` + `stderr` + `cls`). `hexagon agents conformance <id>`
replays each one through the adapter. Record real output with `hexagon agents record <id>`.

**These in-tree fixtures are synthetic**: written from the shape each adapter's parser expects (and the vendors' public docs),
not captured from a real CLI. They prove the parser handles that shape; they do not prove the real CLI still prints it.
Replace them with recordings when you have the CLI.
