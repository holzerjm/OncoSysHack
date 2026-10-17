# Judging Order & Scoring

Apps Script · Running order · Live score sheet

The Open Accelerator · RAG the City · Fort Point, Boston

The **Open**\
Accelerator

One Google Apps Script turns the intake form into the room's running order and the judges' score sheet. It **randomises who presents when**, keeps each track separate, and gives every team four judge blocks that total, average and rank themselves — while every score, note and judge name survives a reshuffle.

## 1 Architecture Read · order · merge · write

The script is a read-modify-write over two tabs. It never stores anything of its own: the `Judging` tab *is* the record, and each run reads that tab back before it rewrites it.

Every run starts by reading the `Judging` tab. That is what makes a mid-event reshuffle safe: the order you are looking at and the scores already typed both come back in before the tab is rebuilt.

### The four decisions this rests on

- **Team name is the identity key**, trimmed and case-folded. Scores rejoin their team by name, not by row. It also means renaming a team in the intake tab orphans its scores — see [§6](#trouble).
- **The sheet is the source of truth.** No hidden properties, no side file. Drag rows around by hand and the next “add new teams” run treats your arrangement as the running order.
- **Formulas, not values.** Totals, averages and ranks are written as live formulas, so they recompute the moment a judge types — and land correctly at the team's new row after a shuffle.
- **The rewrite is total.** The tab is cleared and rebuilt each run, so nothing stale accumulates and two runs in a row produce the same thing.

### Three ways to order

| Menu item | What moves | Use it when |
| --- | --- | --- |
| **Shuffle all tracks** | Every track re-randomised | Setting the room up. Warns first if scores already exist. |
| **Add new teams only** | Nothing — late teams append at the end of their track | Submissions landed after you posted the order. The safe one. |
| **Shuffle one track** | Just the track you pick | One track's order is compromised; the other is already running. |
| **Clear judging order** | Everything | Starting over. Says how many teams have scores before it wipes. |

## 2 What the intake tab must provide The contract

The script reads three columns from a tab named exactly `Form Responses 1`, starting at row 2. Everything else on that tab is ignored.

| Column | Question | Used as | If empty |
| --- | --- | --- | --- |
| `C` | Team Name | Identity key — grouping, display, and how scores find their way home | Row skipped, counted in the warning |
| `D` | Team Members | Display only. Email addresses stripped, line breaks folded into one line | Blank cell, team still listed |
| `J` | Select your challenge track | Section grouping, block colour, and which Track Excellence anchors the header notes show | Team lands in a *No track selected* block at the bottom |

### What it tolerates

- Rows arriving at any time, in any order, during the event.
- A team submitting twice under the same name — collapsed to one entry, most recent row wins, reported in the dialog.
- Emails, commas and line breaks jumbled together in Team Members.
- A third or fourth track appearing — sections are discovered from the data, not hardcoded. Add a colour in `CONFIG.trackColors` and a letter in `CONFIG.trackRubricLetter` if you want it styled and lettered like the others.
- Anything in columns A, B, E–I — timestamps, emails, repo and video links are read by no one but you.

### What breaks it

- **Renaming the tab.** Hard error naming the tab it wanted.
- **Moving a question** so Team Name, Team Members or the track lands in a different column. The run still completes but reports which column looks wrong — fix `CONFIG.colTeam`, `colMembers` or `colTrack` and run again.
- **Renaming a team mid-event.** The old name's scores are orphaned. Rename it back, or re-enter.
- **Two entries for one team under different names** — deduplication is by name only, so both are listed. Fix it in the intake tab.

Eligibility is not the script's job. The card has organizers check the public repo, the two-minute video, the declared track and the two-dataset minimum before the freeze — columns `F`, `H` and `J` hold the first three. The script lists *everyone who submitted*. Remove ineligible teams from the intake tab, or leave them and don't call them up.

## 3 The Judging tab, column by column 28 columns

Judges only ever type in the gold cells. Everything grey is written or computed by the script and will be overwritten on the next run.

Team · frozen

A#

BTeam

CMembers

Judge 1

DRAG

ETrack

FInnov

GPres

H/16

Judge 2

IRAG

JTrack

KInnov

LPres

M/16

Judge 3

NRAG

OTrack

PInnov

QPres

R/16

Judge 4

SRAG

TTrack

UInnov

VPres

W/16

Result

XJudges

YAvg

ZRank

AAAdvance

ABNotes

Judges type here Written or computed by the script Columns A–C stay frozen while you scroll across the judges

### How the card's rules are enforced

| Score sheet says | The tab does |
| --- | --- |
| Circle 1–4 on each criterion | Score cells reject anything but a whole number 1–4 — no half points, no typos |
| Four criteria, 16 max | `/16` per judge sums their four cells |
| Scores are averaged across judges | **Avg / 16** averages the completed judge totals only |
| (Not on the card) | Shows as `8*` and stays out of the average until all four scores are in |
| Never compare Track A to Track B | **Rank** is computed inside one track's block; ties share a rank, first place is highlighted |
| Advance to final? (Round 1 only) | Tick box in column `AA` |
| The final is re-scored fresh | Not automatic — copy the tab before the final (see [§4](#runofshow)) |

Hover any score header for that criterion's full wording, including the right Track Excellence anchors — a Track 1 section shows the *A · Engine* anchors, a Track 2 section the *B · Experience* ones.

## 4 Run of show In order

### Before the room fills

- Install the script ([§5](#install)) and run **Shuffle all tracks** once. Check the dialog's per-track counts against what you expect.
- Rename the merged **Judge 1–4** header cells to the actual judges, per track. Those names are remembered across every later run.
- Fewer than four judges on a track? Leave the spare blocks empty — empty blocks are ignored, not counted as zero.

### At the submission freeze

- Run **Add new teams only**. Teams that submitted late append to the end of their track and nobody already listed moves.
- Post or read out the order. From here on, prefer this over a full shuffle.

### While teams present

- Judges type four integers per team. Totals, averages and ranks update as they go.
- **Judges** (column `X`) is your live completeness check — it counts complete cards, so a `0` next to a team that has already presented means a card is missing or half-entered.
- Notes in `AB` are per team, not per judge. For separate judge comments, keep the paper cards.

### Between rounds

- Read **Rank** within each track and tick **Advance?** for the teams going through. Ranks never cross tracks, so there is nothing to untangle.
- For the final: right-click the `Judging` tab → *Duplicate* and rename it (say `Judging Final`), then clear the score cells in the copy. The card requires the final to be re-scored fresh, and this keeps round 1 intact as the record.

A reshuffle mid-event is safe — scores, notes, ticks and judge names all travel with their team — but the running order changes under people who may have it on paper. That is why the full shuffle asks first once scores exist.

## 5 Install Once, per spreadsheet

1. Open the intake spreadsheet → **Extensions ▸ Apps Script**.
2. Replace the stub `myFunction()` with the contents of `Code.gs` and save.
3. Pick `generateJudgingOrder` in the function dropdown and **Run**. Approve the authorization prompt — this also produces the first order.
4. Reload the spreadsheet. A **Judging** menu appears next to Help.

The script is bound to that one spreadsheet: it reads and writes only its own two tabs, and the authorization is yours, not the judges'. Judges need edit access to the spreadsheet, nothing more.

## 6 When something looks wrong Triage

| Symptom | Cause | Fix |
| --- | --- | --- |
| No **Judging** menu | Sheet not reloaded since install, or the script is not bound to this spreadsheet | Reload. If still missing, re-install from **Extensions ▸ Apps Script** on this spreadsheet. |
| “Sheet *Form Responses 1* was not found” | The intake tab was renamed | Rename it back, or update `CONFIG.sourceSheet`. |
| Warning about column C, D or J | A form question moved | Point `CONFIG.colTeam` / `colMembers` / `colTrack` at the new columns and run again. |
| A team's scores disappeared | Its name changed in the intake tab, so the carry-over could not match it | Restore the old spelling and run again, or re-enter the scores. |
| The same team appears twice | Two submissions under different names | Deduplication only matches identical names — merge them in the intake tab. |
| A judge total shows `13*` | That card has between one and three scores | Working as intended: it is excluded from the average until the fourth score lands. |
| Team columns don't stay put when scrolling | Sheets refused the column freeze | Cosmetic only, and reported in the completion dialog. Freeze columns A–C by hand from *View ▸ Freeze*. |

Invariants

1–4 integers, no half points · scores are averaged across judges · the final is re-scored fresh · never compare Track A to Track B · the sheet is the record — the script only orders, totals and ranks what judges put in it.

Google Apps Script, bound to the RAG the City intake spreadsheet · reads `Form Responses 1`, writes `Judging` The Open Accelerator