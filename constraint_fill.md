# SERVICENOW DRAFTING CONSTRAINTS

OBJECTIVE

- Create draft Incident forms in ServiceNow based on data from JSON/tracker.
- Each data item corresponds to one new Incident form.
- Do not click "Submit" or "Resolve."
- Do not delete, modify, or submit any existing, saved ServiceNow tickets.
- Leave all forms open as drafts upon completion.

DATA SCOPE

- Process only items where `snowTicket` is empty.
- Do not include the tracker number (`trackerNumber`) in Work Notes, Description, Comments, or any other field.
- If `duplicateWarning` contains a value:
- Display/notify the duplicate warning.
- Do not auto-submit.
- You may still proceed with creating a draft if the user explicitly requests it.

RULES FOR CALLER, BUSINESS USER, AND LOCATION

1. Search for `Pelapor` within the Caller selection/autocomplete field; a valid option may contain the tracker value as part of a longer name.
2. If the name is found as a valid reference:

- Set Caller to that valid reference.
- Set Business User to `actualUser`.
- Set Location to `entity` (only if `entity` is provided and exists as a valid reference).

3. If `Pelapor` is empty or not available as a valid option:

- Set Caller to `operational user1`.
- Set Business User to `actualUser`.
- Leave Location empty.

4. Ensure that the "Caller" or "Assigned to" fields do not display an "Invalid reference" status.
5. If the `entity` field in the data is empty, the Location must also be left empty, even if the Caller is valid.
6. When Caller is valid and `entity` is provided but does not match a valid Location option, use a unique historical Location from the training CSV for the same `actualUser` (or Caller) when available; otherwise leave Location empty.

ASSIGNMENT RULES

- Assignment Group:
- Default = `IBM ITSM Service Desk`.
- Use this default if the data is empty or if any other specified group is unavailable or invalid.
- Assigned to:
- Populate `assignedTo` only if the name exists as a valid reference.
- If it is not available, leave the "Assigned to" field empty.
- Do not retain any text that results in an "Invalid reference" error. CHANNEL RULES
- Use the channel value from the data if it is available and matches an option in the form:
- Email → Email
- Walk-in → Walk-in
- Self-service → Self-service
- Phone → Phone
- Chat → Chat
- If the report source is WhatsApp or Microsoft Teams, you must use:
- Channel = `Chat`.

CATEGORY AND SUBCATEGORY RULES

- Use a valid form category:
- Software
- Hardware
- Network
- Database
- Cloud Management
- Service Request
- Security Incident
- Inquiry / Help
- Mapping raw data:
- `Service` → `Service Request`, unless it is strictly a question or a request for information; if it is only a question, use `Inquiry / Help`.
- `Request` → `Service Request`.
- Use a Subcategory only if it is available in the form options and is clear from the context:
- Wi-Fi/wireless network issues → Network - Wireless.
- Printer (`Service Category` = `Printer`) → Hardware - Printing.
- Monitor → Hardware - Monitor.
- Adobe/PDF → Software - Adobe / PDF.
- Email → Software - Email.
- Use a matching value from `Service Category` when it is available as a subcategory under the selected category.
- Do not invent a Subcategory. If no suitable option exists, use `-- None --`.

IMPACT, URGENCY, PRIORITY, AND VIP

- Impact = the `impact` value from the data.
- Urgency = the `urgency` value from the data.
- Do not change the Priority if the field is read-only; let ServiceNow calculate it.
- VIP:
- `vip: true` → select VIP.
- `vip: false` → select Non VIP.

STATE AND RESOLUTION

- The State must match the `state` from the data:
- New
- In Progress
- On Hold
- Resolved
- Tracker status containing `Pending` or `In Pending` maps to `On Hold`.
- If State = Resolved:
- Open the `Resolution Information` subtab.
- Resolution code = `Solution Provided`.
- Fill Resolution Notes from the source resolution details or comments/work notes; if none exist, state that resolution details were not provided.
- Also, populate the Work notes.
- If State = New or In Progress:
- Do not populate the Resolution code or Resolution notes. - Fill in the "Work notes" field, if applicable.
- If the "State" is set to "On Hold":
- Use the `Pending Reason` column as the "Work notes" content.
- Include clear follow-up steps (visible to the customer) in the "Comments" field, if necessary.
- Map a clear pending reason to an available "On hold reason": caller/user waiting → `Awaiting Caller`; change → `Awaiting Change`; problem → `Awaiting Problem`; vendor/supplier/manufacturer waiting → `Awaiting Vendor`.
- Select an "On hold reason" only if one of the available options is truly appropriate; for example, `Waiting Confirmation Lenovo` maps to `Awaiting Vendor`.
- Do not force an irrelevant "On hold reason."

SHORT DESCRIPTION FORMAT

- Must be in English.
- Use one of the following prefixes:
- `Issue with ...` for incidents or errors.
- `Request for ...` for service requests, installations, access, licenses, accounts, device deployments, or changes.
- `Inquiry regarding ...` for questions.
- The "Short description" must be concise and specific.
- Do not mix Indonesian and English within the "Short description."

DESCRIPTION FORMAT
Use the following exact format:

Issue:
[description of the issue or request in English]

User Affected:
[actualUser name] - [entity]

Affected Service:
[Category]
or
[Category] - [Subcategory]

Example:
Issue:
Unable to connect to the Danantara Wi-Fi SSID.

User Affected:
Dio Aufa - DAM

Affected Service:
Network - Wireless

DESCRIPTION NOTES

- Do not include tracker numbers or INC (incident) numbers.
- Do not add "Action" or "Notes" sections within the "Description."
- If the "entity" is blank, provide only the user's name without an additional hyphen:
  `User Affected:
Raisya Alianti`
- Do not use the words "Incident" or "Services" under "Affected Service."
- Use the exact category/subcategory selected in the form, if available.

WORK NOTES FORMAT

- Use English.
- Retain the original timestamps from the data, if available.
- Document technical actions taken and their outcomes.
-
