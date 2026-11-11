# Fable OS: build session report

One Claude Code session, one model (Claude Fable 5.2), about two and a half hours.

| | |
|---|---|
| Date | Wednesday 11 November 2026 |
| Duration | 06:57 to 09:25 IST (2 h 28 min) |
| Model | Claude Fable 5.2 in Claude Code |
| Requests from me | 22 |
| Model responses | 92 |
| Code | 835 lines at the start, 1,715 at the end, across 7 files, zero dependencies |

## What it cost

### Building the OS (this session)

| | Tokens | Cost at API rates |
|---|---:|---:|
| New input | 222 | $0.00 |
| Written to cache | 276,896 | $4.43 |
| Re-read from cache | 19,710,299 | $3.94 |
| Output | 138,381 | $5.54 |
| **Total** | **20,125,798** | **$13.91** |

- Rates used: $8 per million input tokens, $40 per million output, $16 per million written to the one-hour cache, $0.20 per million read from cache.
- The session ran on a Claude subscription login, so $13.91 is what the same work would cost through the API, not an amount billed.
- 98% of the tokens are cached context being re-read on each step. They are cheap: they make up 98% of the volume and 28% of the cost.
- Figures were taken just before this report was written, so they leave out the last few thousand tokens spent writing it.

### Running the OS (agents inside Fable OS)

From the OS's own audit log, for the live copy:

| Model | Runs | Tokens | Cost |
|---|---:|---:|---:|
| Claude Fable 5.2 | 5 | 1,195,805 | $1.84 |
| Claude Sonnet 5.5 | 4 | 239,607 | $0.42 |
| GPT-5.6 Luna (Codex) | 10 | 2,932,147 | not reported by Codex |
| **Total** | **19** | **4,367,559** | **$2.26** |

Test runs on a separate scratch copy cost about another $6.90. Of that, $5.95 was measured ($0.68 for the first feature tests, $5.27 for one full self-improvement pass) and roughly $0.90 is an estimate for three runs whose log was overwritten.

### All in

About **$23** at API rates: $13.91 to build, $2.26 of live use, about $6.90 of testing.

## What was built, in order

### 1. Five features from one pasted list (06:57)

The starting point was a small local "agentic OS": a Node server and one web page with voice, Gmail and Calendar access, a markdown vault as its second brain, and mouse and keyboard control of the Mac. It ran Sonnet 5.5 and GPT-5.6 Luna. I pasted a five-item wish list and nothing else.

1. **Fable as a third engine with automatic routing.** Quick questions go to Sonnet, long jobs go to Fable. Long jobs keep running in the background and keep the Mac awake.
2. **Approvals enforced in code.** Agents lost their shell and their direct access to Google. Reads run immediately. Emails, proposals and any change in Google wait in a queue and only go when I click. Drafts can be edited first.
3. **One audit log and loud failures.** Every run, tool call, approval and failure goes in one log. A failed run raises a red banner and a macOS notification with a sound.
4. **Skill buttons with model and effort pickers.** The five buttons now run skills from the vault, each with its own model and effort level.
5. **A business panel.** Leads, proposals waiting, and spend per day with a seven-day chart.

Two things it added without being asked, to make the approval claim true: mouse and keyboard control needs one click per run, and any shell command needs a click each time.

Bug found and fixed during testing: Fable's replies came back empty, because the output parser only recognised the Sonnet engine name.

### 2. Codex computer control fixed (07:55)

Codex kept saying it could not control the Mac. Cause: Codex ships its own screen-control plugin, which only works inside the ChatGPT app. It reached for that, found it blocked, and gave up. The plugin's tool is now switched off for these runs, and Codex uses the OS's own tools.

### 3. Sample leads (08:05)

Eight fictional leads replaced the real client accounts in the business panel, so real names stay off screen in recordings.

### 4. Fable on its own login (08:15)

Fable runs now always use a separate Claude Code login, however the server is started. Sonnet and Fable hand the conversation to each other when I switch.

### 5. Token counting (08:25)

A Usage view shows tokens per model, in total and per session, split into new input, cached input and output. Each reply shows its own count.

### 6. New voice (08:35)

Switched to a new ElevenLabs voice and confirmed it by speaking a line and transcribing it back.

### 7. Self-improvement (08:45)

An Improve button. Fable reads every past session and the failure log, then suggests changes to the OS's own code, each with the evidence from my sessions.

- I pick which to build.
- Fable builds them in a staged copy, never the running code.
- Syntax checks and the test suite run on the copy.
- I see the diff, and the running OS changes only when I click Apply. The old files are kept for Undo.

On its first pass over ten real sessions it found six changes, including "add a drag tool, because both drawing requests failed" and "stop calling an event that has already started my next event". The pass cost $5.27 on the scratch copy.

Saying or typing "improve yourself" now starts the same workflow.

### 8. Renamed to Fable OS (09:00)

It started the session as Noor OS.

### 9. Three attempts at the look (09:05)

- More colourful: I called it an eyesore.
- Muted and tasteful: kept.
- Solid colours: previewed side by side, then dropped.

### 10. Memory counter fixed (09:20)

The memory gauge always read 98%. It was counting memory that macOS deliberately fills with file cache. It now counts the same way Activity Monitor does, and reads about 80%.

## How it was checked

- Real agent runs on all three models, on a scratch copy so my live data was never touched.
- Sending an approved email was tested with a dry run only. No real email was sent.
- The page was checked with headless-browser screenshots after each visual change.
- The failure alert was tested by starting a run with the Claude binary deliberately missing.
- The test suite covers the approval rules, model routing and the tool list. It does not cover the page or full agent runs.
