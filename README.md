# Job Command Center

Local dashboard for applications, status, and LinkedIn suggestions coming out of Grok Bot (Job Tracker Bot, LinkedIn Job Bot, Job Email Bot).

Grok Bot has no public read API for those conversations. This app is the sink: the bots write JSON to your Mac, and the board displays it.

## Run

```bash
./start.sh
```

Then open [http://127.0.0.1:3847](http://127.0.0.1:3847).

Requires the system Ruby that ships with macOS (`ruby`, `webrick`). No Node install.

## Connect the bots

1. Keep this server running.
2. Open **Connect bots** in the dashboard.
3. Paste the Job Tracker / LinkedIn / Email prompts into those Grok Bots.
4. Tell each bot to use **Execution on Local Computer**. A curl from the cloud computer’s `127.0.0.1` will not hit this Mac.

If HTTP from a bot is blocked, drop the same JSON files into `data/inbox/`.

## Data

- `data/store.json` — board state
- `data/token.txt` — ingest token
- `data/inbox/*.json` — file drop
