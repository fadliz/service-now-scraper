# ServiceNow Incident Workflow

Workflow automation for the **classic/default ServiceNow Incident form** demonstrated in the current session. It processes rows from `tracker-paste.txt` regardless of ticket date, skips any row that already has `Snow Ticket`, checks for likely duplicates when matching history includes a Location, fills the ServiceNow form, and only submits when explicitly invoked with `--submit`.

## Safety and operating model

- `prepare` is read-only. It creates `run/drafts.json` with eligible incidents and any duplicate warnings.
- `fill` opens one ticket draft at a time at `SNOW_URL`, **does not click Submit**, and keeps the browser open for manual review. Press Enter after reviewing/submitting to continue; after all rows, press Enter again only when you want to close Brave. Manually submitted tickets are recorded only when ServiceNow confirms the save and exposes an incident number; otherwise the workflow warns and continues without recording that ticket.
- `submit` is the explicit opt-in action that creates the ServiceNow record and records the result in `run\servicenow-incidents.json`.

## Tracker paste input (`.txt`)

Select the required columns in Excel and paste the copied Markdown-style table into `tracker-paste.txt` in the project root. Commands use that file by default. To use a different file, set `TRACKER_TXT`. The parser handles blank cells, separator rows, HTML `<br>` values, non-breaking spaces, and trailing empty columns.

```text
TRACKER_TXT=tracker-paste.txt
```

Run `npm run clean` to delete generated JSON output, then inspect parsed rows before opening ServiceNow:

```powershell
npm run clean
npm run parse
npm run prepare
```

The cleaned data is saved to `run\cleaned-tracker.json`; draft tickets are saved to `run\drafts.json`.

## Multiple incident creation

Set `DASHBOARD_URL` to the dashboard page used by the workflow. For each selected tracker row, it opens the dashboard and clicks the **Input New Incident** widget when present, then opens `SNOW_URL` directly as a fallback. It fills one incident, waits for your manual review/submission, then moves to the next row after you press **Enter** in the terminal. At the end of `fill`, Brave remains open until you press Enter again to close it.

```powershell
node src/workflow.mjs fill --all
```

After the run, successfully submitted incidents are listed in `run\servicenow-incidents.json`.
## Setup

```powershell
cd C:\Users\MohamadNorhavid\Documents\Codex\2026-11-19\saya-ingin-kamu-membuat-script-automation\outputs\servicenow-incident-workflow
npm install
Copy-Item .env.example .env
```

Set the paths in `.env` or through environment variables:

```text
TRACKER_TXT=tracker-paste.txt
TRAINING_CSV=dataset_incident.csv
SNOW_URL=https://your-instance.service-now.com/incident.do?sys_id=-1
```

## Authentication strategy

The workflow uses the minimal portion of the recorded flow:

1. Navigate to `SNOW_URL` and reuse an existing authenticated session when one exists.
2. If the incident form is unavailable, navigate to the instance login page.
3. Fill the `User name` and `Password` controls from `SNOW_USERNAME` and `SNOW_PASSWORD`. If `SNOW_PASSWORD` is empty, `fill` prompts for it without echoing the input.
4. Click `Log in`, wait for the login form to close, then follow the dashboard navigation configured by `DASHBOARD_URL`.
5. Open the incident form. For Resolved drafts, the workflow switches to **Resolution Information** and fills the resolution code and notes; it does not switch to **Related Records**.

Do **not** hard-code credentials in `workflow.mjs`, `.env.example`, Git, screenshots, or test files. Set them only for the active PowerShell session, or leave `SNOW_PASSWORD` empty and enter it at the hidden terminal prompt:

```powershell
$env:SNOW_USERNAME='your-service-account'
$env:SNOW_PASSWORD='your-password'
npm run fill
```
## Brave browser profile and manual review

The automation launches the **Brave executable**, not Playwright's bundled Chromium, using a fresh temporary browser context per run. It saves the authenticated browser state locally at `%LOCALAPPDATA%\ServiceNowIncidentWorkflow\session-state.json`, allowing the next run to reuse a valid ServiceNow session without reopening a persistent Brave profile. If the session expires, the script prompts for the password and updates the saved state after login. This file contains sensitive session tokens; do not share or commit it. Delete it to force a new login. The workflow closes only the Brave instance it started when the run finishes; regular Brave tabs are not touched.

If navigation fails with `net::ERR_FAILED` or times out while the page remains `about:blank`, the workflow reports the navigation issue directly instead of continuing into another misleading error.

`npm run fill` opens the form, fills it, and waits for you to review/submit manually in Brave. After processing the rows, it keeps Brave open until you explicitly press **Enter** in the terminal to close it. The script records any detected created INCs in `run\servicenow-incidents.json`.

To attach to an already logged-in Brave session, start Brave manually with CDP enabled and set `BROWSER_MODE=cdp`:

```powershell
& 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe' `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data"
```

`BROWSER_MODE=cdp` attaches to your manually launched Brave instance and leaves that browser open after the run. The default `BROWSER_MODE=brave` starts an isolated temporary context instead.

## Commands

```powershell
# Build drafts for rows with a blank Snow Ticket, regardless of ticket date.
npm run prepare

# Fill only the first eligible form. It leaves the draft open for human review.
npm run fill

# Submit the form and record the result in run\servicenow-incidents.json.
npm run submit
```

Use `--all` after `fill` or `submit` to process every eligible record rather than only the first one.

## Implemented business rules

1. Uses the Caller reference autocomplete to select a unique option containing `Pelapor`, falling back to the lookup list if needed. If no unique match exists, it selects `DEFAULT_CALLER` from `.env` (default: `operational user1`) and verifies the reference ID was populated.
2. `Business User` is populated from `Nama User`, independently of whether the caller fallback was used.
3. The saved Incident form has a **Configuration item** field, not a **Business Application** field; this workflow leaves Configuration item untouched.
4. **Location** is selected as a valid reference only for a valid non-default caller and a non-empty `Entity`. If the entity does not match an option, the workflow can recommend a unique historical `Location` from the training CSV for the same Business User or Caller; unresolved values are cleared with a warning.
5. Service and Service Offering are always cleared for this workflow.
6. Excel `VIP` values `Y`, `YES`, `VIP`, or `TRUE` map to VIP; all other values (including `N`) map to Non VIP.
7. Raw category `Service` maps to **Service Request** unless the source is strictly an inquiry; `Request` maps to **Service Request**. Service Category is mapped to a matching subcategory when available (for example, Hardware / Printer maps to **Printing**). If no matching subcategory is available, `-- None --` is selected.
8. Work notes are populated in the **Notes** tab. Pending statuses map to **On Hold**, and use `Pending Reason` as the work note. The script removes internal `INC...` or long numeric ticket references from work notes.
9. Resolved drafts use **Solution Provided** and the source ticket's notes for Resolution Notes. If the source has no resolution details, the field states that explicitly. Automatic submit remains disabled for Resolved drafts.
10. On-hold reasons are selected only when `Pending Reason` maps to an available reason (for example, `Waiting Confirmation Lenovo` → **Awaiting Vendor**); otherwise the form's `-- None --` remains selected.
11. Assignment group defaults to `IBM ITSM Service Desk`. If an Assigned-to suggestion is unavailable, the field is cleared.

## Improving Location recommendations

The workflow reads `TRAINING_CSV` each time it prepares drafts. It accepts comma- or semicolon-delimited CSV, including quoted fields, and recognizes common export headers such as `u_business_user` and `caller_id` when matching people. History-based duplicate warnings also require a matching Location, so the supplied export cannot produce those warnings until it includes Location.

The supplied 30-row export has no `Location` column, so it cannot teach Location values; `prepare` warns when this is the case. It also lacks category, impact, urgency, hold reason, and resolution fields. Subcategory is blank in 19 rows, and some populated values are category-like rather than subcategory values, so the workflow does not infer form choices from this history. The export is resolved-heavy (26 of 30 records), and its historical states are not used to choose a draft status. To train Location recommendations, re-export the history with the exact Location display value and a Business User or Caller column.

To teach it a Location value that works in your ServiceNow form:

1. Review the filled draft. If Location is blank or incorrect, select the correct Location reference in ServiceNow.
2. Add or correct that ticket's historical row in the CSV configured by `TRAINING_CSV`, including `Business_User` (or `u_business_user`), `Caller` (or `caller_id`), and the exact `Location` display value from the form.
3. Run `npm run prepare` again. `run\drafts.json` shows `locationCandidate` and whether it came from `dataset` history or the tracker `Entity`. The workflow uses a unique most-common historical Location for a matching user; ties fall back to the tracker Entity.

The script reads but never edits the training CSV. A recommended value is still selected only if ServiceNow offers it as a valid Location reference.

## Important review point

The Excel tracker may contain Indonesian issue text. The script includes the demonstrated SharePoint/Prisma English title and summary rule. Add approved translations to `ISSUE_TRANSLATIONS` in `src/workflow.mjs` for other recurring issue types before using bulk submit.






