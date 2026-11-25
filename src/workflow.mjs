import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUN = path.join(ROOT, 'run');
const DRAFT_PATH = path.join(RUN, 'drafts.json');
const RESULT_PATH = path.join(RUN, 'servicenow-incidents.json');
const CLEAN_PATH = path.join(RUN, 'cleaned-tracker.json');
const SESSION_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'ServiceNowIncidentWorkflow')
  : RUN;
const SESSION_PATH = path.join(SESSION_DIR, 'session-state.json');
const MAX_BATCH_SIZE = 8;

loadDotEnv(path.join(ROOT, '.env'));
fs.mkdirSync(RUN, { recursive: true });

const CONFIG = {
  trackerTextPath: path.resolve(ROOT, process.env.TRACKER_TXT || 'tracker-paste.txt'),
  trainingCsvPath: path.resolve(ROOT, mustEnv('TRAINING_CSV')),
  snowUrl: mustEnv('SNOW_URL'),
  dashboardUrl: process.env.DASHBOARD_URL || '',
  defaultCaller: process.env.DEFAULT_CALLER || 'operational user1',
  assignmentGroup: 'IBM ITSM Service Desk',
  // "brave" launches a fresh Brave context. "cdp" attaches
  // to a Brave window that the user started with --remote-debugging-port=9222.
  browserMode: (process.env.BROWSER_MODE || 'brave').toLowerCase(),
  braveExecutable: process.env.BRAVE_EXECUTABLE || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222',
  snowUsername: process.env.SNOW_USERNAME || '',
  snowPassword: process.env.SNOW_PASSWORD || '',
};

const ISSUE_TRANSLATIONS = [
  {
    test: /tidak\s+bisa\s+buka\s+link\s+sharepoint.*email/i,
    short: 'Issue with opening a SharePoint link from email',
    issue: 'Unable to open a SharePoint link from email.',
    category: 'Software',
    subcategory: 'Browser / Prisma',
  },
];

const args = new Set(process.argv.slice(2));
const command = process.argv[2] || 'prepare';
const submit = args.has('--submit');

if (!['prepare', 'parse', 'clean', 'fill'].includes(command)) {
  throw new Error('Use: prepare | parse | clean | fill [--submit]');
}

if (command === 'prepare') {
  const drafts = prepareDrafts();
  writeJson(DRAFT_PATH, drafts);
  console.log(`Prepared ${drafts.items.length} eligible ticket(s). Review: ${DRAFT_PATH}`);
  if (drafts.items.some((item) => item.duplicateWarning)) {
    console.log('Duplicate warnings exist. Review them before running fill/submit.');
  }
} else if (command === 'parse') {
  const rows = loadSelectedTrackerRows();
  writeJson(CLEAN_PATH, { cleanedAt: new Date().toISOString(), rows });
  console.log(`Parsed ${rows.length} tracker row(s). Output: ${CLEAN_PATH}`);
} else if (command === 'clean') {
  for (const generatedFile of [CLEAN_PATH, DRAFT_PATH, RESULT_PATH]) fs.rmSync(generatedFile, { force: true });
  console.log('Removed generated run files: cleaned-tracker.json, drafts.json, and servicenow-incidents.json.');
} else {
  // Rebuild on every run: the tracker changes throughout the day, so a stale
  // drafts.json must never make the fill step look like it has no work.
  const drafts = prepareDrafts();
  writeJson(DRAFT_PATH, drafts);
  const queue = drafts.items.filter((item) => !item.duplicateWarning);
  if (!queue.length) {
    throw new Error(`No non-duplicate draft is available. Rows with an existing Snow Ticket or duplicate warning are excluded. Review ${DRAFT_PATH}.`);
  }
  const batchSize = submit ? 1 : await promptForBatchSize();
  await runForms(queue, submit, batchSize);
}

function prepareDrafts() {
  const rows = loadSelectedTrackerRows();
  const training = parseTrainingCsv(CONFIG.trainingCsvPath);
  if (training.length && !hasDatasetColumn(training, 'Location', 'location')) {
    console.warn('TRAINING_CSV has no Location column; history-based Location recommendations require adding Location to the CSV.');
  }
  if (training.length && !hasDatasetColumn(training, 'Business_User', 'Business User', 'u_business_user', 'Caller', 'caller_id')) {
    console.warn('TRAINING_CSV has no Business User or Caller column; person-based history matching is unavailable.');
  }
  const items = rows
    .filter((row) => !String(row['Snow Ticket'] || '').trim())
    .map((row) => makeDraft(row, training));

  return { generatedAt: new Date().toISOString(), items };
}

function makeDraft(row, training) {
  const actualUser = clean(row['Nama User']) || clean(row['Pelapor']);
  const matched = ISSUE_TRANSLATIONS.find((rule) => rule.test.test(clean(row['Deskripsi Laporan'])));
  const issue = matched?.issue || clean(row['Deskripsi Laporan']);
  const short = matched?.short || `Issue with ${toEnglishish(issue)}`;
  const callerCandidate = clean(row['Pelapor']);
  const entity = clean(row['Entity']);
  const locationRecommendation = recommendLocation(training, actualUser, callerCandidate, entity);
  const state = mapState(row['Status']);
  const originalNotes = clean(row['Comments and Work notes']);
  const pendingReason = clean(row['Pending Reason']);
  const noteSource = state === 'On Hold' ? pendingReason : originalNotes;
  const note = noteSource ? formatWorkNote(noteSource, row['Ticket Date'], row['Ticket Time']) : '';

  const categoryContext = `${row['Request Type'] || ''} ${row['Judul email'] || ''} ${issue}`;
  const category = matched?.category || mapCategory(row['Category'], categoryContext);
  const serviceCategory = clean(row['Service Category']);
  const subcategory = isMeetingRoomRequest(category, categoryContext)
    ? 'Inquiry / Help'
    : matched?.subcategory || mapSubcategory(category, serviceCategory);
  const affectedService = subcategory ? `${category} - ${subcategory}` : category;
  const duplicate = findLikelyDuplicate(training, actualUser, entity, issue);
  return {
    rowNumber: row.__rowNumber__,
    source: row.__source__ || 'txt',
    trackerNumber: clean(row['Ticket NO']),
    snowTicket: '',
    actualUser,
    callerCandidate,
    entity,
    locationCandidate: locationRecommendation.value,
    locationRecommendationSource: locationRecommendation.source,
    channel: mapChannel(row['Sumber Laporan']),
    vip: isVip(row['VIP']),
    category,
    subcategory,
    state,
    holdReason: state === 'On Hold' ? mapHoldReason(pendingReason, row['Pending With']) : '',
    impact: mapLevel(row['Impact']),
    urgency: mapLevel(row['Urgency']),
    assignmentGroup: CONFIG.assignmentGroup,
    assignedTo: clean(row['Assigned to']),
    shortDescription: short,
    description: `Issue:\n${issue}\n\nUser Affected:\n${actualUser} - ${clean(row['Entity'])}\n\nAffected Service:\n${affectedService}`, 
    workNotes: note,
    resolutionCode: state === 'Resolved' ? 'Solution Provided' : '',
    resolutionNotes: state === 'Resolved'
      ? stripInternalReferences(originalNotes) || 'No resolution details were provided in the source tracker.'
      : '',
    duplicateWarning: duplicate ? `[ALERT: TERINDIKASI DUPLIKAT] ${duplicate.Short_description || duplicate.short_description || ''}` : '',
  };
}

async function runForms(items, shouldSubmit, batchSize = 1) {
  const session = await openBraveSession();
  const { browser, context, page, closeWhenDone } = session;
  const results = [];
  let completed = false;

  try {
    if (shouldSubmit) {
      for (const draft of items) {
        if (draft.state === 'Resolved') {
          throw new Error('Automatic submission is disabled for Resolved drafts. The form remains a draft for review.');
        }
        console.log(`Opening ${draft.trackerNumber} (source ${draft.rowNumber})`);
        await openIncidentForm(page);
        await fillDefaultView(page, draft);

        await page.getByRole('button', { name: 'Submit', exact: true }).last().click();
        await page.waitForLoadState('domcontentloaded');
        const incidentNumber = await verifiedIncidentNumber(page);
        results.push(finalizeIncident(draft, incidentNumber, 'automatic'));
        console.log(`Submitted ${incidentNumber}; recorded ${draft.trackerNumber}.`);
      }
    } else {
      await ensureAuthenticated(page);
      const batches = splitIntoBatches(items, batchSize);
      const pages = [page];
      const pageCount = Math.min(batchSize, items.length);
      for (let index = 1; index < pageCount; index += 1) {
        pages.push(await context.newPage());
      }

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];
        console.log(`Filling batch ${batchIndex + 1}/${batches.length} (${batch.length} ticket(s)).`);
        const fillResults = await Promise.allSettled(batch.map(async (draft, index) => {
          const draftPage = pages[index];
          console.log(`Opening ${draft.trackerNumber} (source ${draft.rowNumber})`);
          await openIncidentForm(draftPage, { authenticated: true });
          await fillDefaultView(draftPage, draft);
          await draftPage.evaluate((trackerNumber) => {
            document.title = `${trackerNumber} - ${document.title}`;
          }, draft.trackerNumber);
          return draftPage;
        }));
        const failures = fillResults.flatMap((result, index) => result.status === 'rejected'
          ? [new Error(`${batch[index].trackerNumber}: ${result.reason?.message || String(result.reason)}`, { cause: result.reason })]
          : []);
        if (failures.length) {
          throw new AggregateError(
            failures,
            `Failed to fill ${failures.length} draft(s) in batch ${batchIndex + 1}.`,
          );
        }

        console.log('Drafts filled. Review and submit these forms in Brave before continuing:');
        for (const [index, draft] of batch.entries()) {
          console.log(`  Tab ${index + 1}: ${draft.trackerNumber} (source ${draft.rowNumber})`);
        }
        console.log('Press Enter after reviewing/submitting this batch to open the next batch.');
        await waitForEnter();
        const batchResults = await Promise.all(batch.map((draft, index) => markManualSubmissionIfDetected(pages[index], draft)));
        results.push(...batchResults.filter(Boolean));
      }
    }
    if (closeWhenDone && !shouldSubmit) {
      console.log('Review and submit in Brave. Press Enter only when you are ready to close the browser.');
      await waitForEnter();
    }
    completed = true;
  } finally {
    if (results.length) writeJson(RESULT_PATH, { generatedAt: new Date().toISOString(), incidents: results });
    if (closeWhenDone && completed) {
      if (browser) await browser.close();
      else await context.close();
    } else if (closeWhenDone) {
      console.warn('Workflow stopped before completion; Brave was left open for review.');
    }
  }
}

async function openBraveSession() {
  if (CONFIG.browserMode === 'cdp') {
    const browser = await chromium.connectOverCDP(CONFIG.cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error(`No browser context is available at ${CONFIG.cdpUrl}.`);
    return { browser, context, page: await context.newPage(), closeWhenDone: false };
  }
  if (!fs.existsSync(CONFIG.braveExecutable)) throw new Error(`Brave executable was not found: ${CONFIG.braveExecutable}`);
  const browser = await chromium.launch({
    executablePath: CONFIG.braveExecutable,
    headless: false,
  });
  const contextOptions = { viewport: null, ignoreHTTPSErrors: true };
  if (fs.existsSync(SESSION_PATH)) contextOptions.storageState = SESSION_PATH;
  let context;
  try {
    context = await browser.newContext(contextOptions);
  } catch (error) {
    if (contextOptions.storageState) {
      await browser.close();
      throw new Error(`Could not load the saved ServiceNow session state at ${SESSION_PATH}. Remove that file to sign in again.`, { cause: error });
    }
    await browser.close();
    throw error;
  }
  return { browser, context, page: await context.newPage(), closeWhenDone: true };
}

async function openIncidentForm(page, { authenticated = false } = {}) {
  if (!authenticated) await ensureAuthenticated(page);

  if (CONFIG.dashboardUrl) {
    await safeGoto(page, CONFIG.dashboardUrl);
    const inputNewIncident = page.locator('now-image[alt="Input New Incident"] a.now-image-link[href="/incident.do?sys_id=-1"]');
    try {
      await inputNewIncident.waitFor({ state: 'visible', timeout: 15000 });
      await inputNewIncident.click();
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error;
      console.warn('Input New Incident widget was not found on the dashboard; opening SNOW_URL directly.');
    }
  }

  await safeGoto(page, CONFIG.snowUrl);
  if (!await waitForIncidentForm(page, 15000)) throw new Error(`Could not open the incident form. Current page: ${page.url()}.`);
}

async function ensureAuthenticated(page) {
  await safeGoto(page, CONFIG.snowUrl);
  if (await waitForIncidentForm(page, 15000)) {
    await saveSessionState(page.context());
    return;
  }

  let loginForm = await waitForLoginForm(page, 1000);
  if (!loginForm) {
    const loginUrl = new URL('/login.do', CONFIG.snowUrl).toString();
    await safeGoto(page, loginUrl);
    loginForm = await waitForLoginForm(page, 15000);
  }
  if (!loginForm) throw new Error(`ServiceNow form is unavailable and no login form is visible. Current page: ${page.url()}.`);
  if (!CONFIG.snowUsername) throw new Error('The ServiceNow login form is open, but SNOW_USERNAME is empty.');
  const snowPassword = CONFIG.snowPassword || promptForSnowPassword();
  await loginForm.username.fill(CONFIG.snowUsername);
  await loginForm.username.press('Tab');
  await loginForm.password.fill(snowPassword);
  await loginForm.loginButton.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  await safeGoto(page, CONFIG.snowUrl);
  if (!await waitForIncidentForm(page, 20000)) {
    throw new Error(`ServiceNow login did not reach the incident form. Current page: ${page.url()}.`);
  }
  await saveSessionState(page.context());
}

async function saveSessionState(context) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  await context.storageState({ path: SESSION_PATH });
  console.log('Saved ServiceNow session state locally.');
}

function promptForSnowPassword() {
  if (!process.stdin.isTTY) {
    throw new Error('SNOW_PASSWORD is empty and no interactive terminal is available. Set it in the active terminal environment before running fill.');
  }
  const script = [
    "$secret = Read-Host 'ServiceNow password (input hidden)' -AsSecureString",
    '$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)',
    'try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }',
    'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }',
  ].join('\n');
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'inherit'],
    }).replace(/[\r\n]+$/, '');
  } catch (error) {
    throw new Error('Could not read the ServiceNow password securely from the terminal.', { cause: error });
  }
}

async function waitForLoginForm(page, timeout) {
  const username = page.getByRole('textbox', { name: /user ?name/i });
  const password = page.getByRole('textbox', { name: /password/i });
  const loginButton = page.getByRole('button', { name: /log in/i });
  try {
    await Promise.all([
      username.waitFor({ state: 'visible', timeout }),
      password.waitFor({ state: 'visible', timeout }),
      loginButton.waitFor({ state: 'visible', timeout }),
    ]);
    return { username, password, loginButton };
  } catch (error) {
    if (error?.name === 'TimeoutError') return null;
    throw error;
  }
}

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
  } catch (error) {
    if (error?.name === 'TimeoutError' && !page.isClosed() && page.url() === 'about:blank') {
      throw new Error(`Brave did not start navigation to ${url}. Check network access and retry with a fresh Brave session.`, { cause: error });
    }
    // Continue after an interrupted navigation only if the browser reached a
    // real page where login detection can run.
    const recoverable = /net::ERR_(FAILED|ABORTED)/i.test(String(error?.message));
    if (!recoverable || page.isClosed()) throw error;
    const currentUrl = page.url();
    if (currentUrl === 'about:blank') {
      throw new Error(`Navigation to ${url} failed before Brave loaded a page. Check network access and retry with a fresh Brave session.`, { cause: error });
    }
    console.warn(`Navigation was interrupted at ${currentUrl}; continuing with login/form detection.`);
  }
}
async function waitForIncidentForm(page, timeout) {
  try {
    await page.locator('#incident\\.short_description').waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function hasIncidentForm(page) {
  return page.locator('#incident\\.short_description').isVisible().catch(() => false);
}

async function verifiedIncidentNumber(page) {
  const incidentNumber = await page.locator('#sys_readonly\\.incident\\.number').inputValue().catch(() => '');
  if (!/^INC\\d+$/i.test(incidentNumber)) throw new Error('Could not verify the submitted incident number.');
  return incidentNumber;
}

async function markManualSubmissionIfDetected(page, draft) {
  let incidentNumber = '';
  let successMessage = '';
  let submitted = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    incidentNumber = await page.locator('#sys_readonly\\.incident\\.number').inputValue().catch(() => '');
    successMessage = (await page.locator('.outputmsg, .outputmsg_div, [role="alert"], .alert-success').allInnerTexts()).join(' ');
    let formState = { isNewRecord: null, sysId: '' };
    try {
      formState = await page.evaluate(() => {
        const form = window.g_form;
        return {
          isNewRecord: typeof form?.isNewRecord === 'function' ? form.isNewRecord() : null,
          sysId: typeof form?.getUniqueValue === 'function' ? form.getUniqueValue() : '',
        };
      });
    } catch (error) {
      if (!/execution context was destroyed|cannot find context with specified id/i.test(String(error?.message))) throw error;
    }
    const urlSysId = new URL(page.url()).searchParams.get('sys_id') || '';
    submitted = formState.isNewRecord === false
      || Boolean(formState.sysId && formState.sysId !== '-1')
      || Boolean(urlSysId && urlSysId !== '-1')
      || /\b(inserted|created|saved|submitted)\b/i.test(successMessage);
    if (submitted) break;
    await page.waitForTimeout(250);
  }
  if (!submitted) {
    console.warn('Manual submission could not be verified; continuing without recording this ticket number.');
    return null;
  }
  const incidentFromMessage = successMessage.match(/\bINC\d+\b/i)?.[0] || '';
  const verifiedNumber = /^INC\d+$/i.test(incidentNumber) ? incidentNumber : incidentFromMessage;
  if (!verifiedNumber) {
    console.warn('ServiceNow confirmed a save, but no incident number could be read; continuing without recording this ticket.');
    return null;
  }
  const result = finalizeIncident(draft, verifiedNumber, 'manual');
  console.log(`Manual submission detected: ${verifiedNumber}; recorded ${draft.trackerNumber}.`);
  return result;
}

function finalizeIncident(draft, incidentNumber, mode) {
  return { trackerTicket: draft.trackerNumber, serviceNowTicket: incidentNumber, sourceRow: draft.rowNumber, mode };
}

async function promptForBatchSize() {
  if (!process.stdin.isTTY) {
    throw new Error('Batch drafting requires an interactive terminal so you can choose the batch size and review each batch.');
  }
  while (true) {
    const input = await readTerminalLine(`Tickets per batch (1-${MAX_BATCH_SIZE}): `);
    try {
      return parseBatchSize(input);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      console.error(error.message);
    }
  }
}

function readTerminalLine(prompt) {
  process.stdout.write(prompt);
  process.stdin.resume();
  return new Promise((resolve) => {
    process.stdin.once('data', (data) => resolve(data.toString().trim()));
  });
}

function parseBatchSize(input) {
  const value = String(input).trim();
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`Enter a whole number between 1 and ${MAX_BATCH_SIZE}.`);
  }
  const batchSize = Number(value);
  if (batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`Batch size must be between 1 and ${MAX_BATCH_SIZE}.`);
  }
  return batchSize;
}

function splitIntoBatches(items, batchSize) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`Batch size must be between 1 and ${MAX_BATCH_SIZE}.`);
  }
  const batches = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

function waitForEnter() {
  if (!process.stdin.isTTY) throw new Error('Manual review requires an interactive terminal; run fill from a terminal so Brave stays available.');
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

async function fillDefaultView(page, draft) {
  await fillAndSelectReference(page, '#sys_display\\.incident\\.caller_id', draft.callerCandidate, CONFIG.defaultCaller, { useLookup: true });
  const selectedCaller = await page.locator('#sys_display\\.incident\\.caller_id').inputValue();
  const usingDefaultCaller = selectedCaller.toLowerCase() === CONFIG.defaultCaller.toLowerCase();

  await page.locator('#incident\\.u_business_user').fill(draft.actualUser);
  await page.locator('#sys_display\\.incident\\.business_service').fill('');
  await page.locator('#sys_display\\.incident\\.service_offering').fill('');
  const locationCandidate = usingDefaultCaller ? '' : draft.locationCandidate;
  const locationSelected = await fillAndSelectReference(
    page,
    '#sys_display\\.incident\\.location',
    locationCandidate,
    '',
    { allowBlank: true },
  );
  if (locationCandidate && !locationSelected) {
    console.warn(`Location "${locationCandidate}" was not found as a valid reference; leaving Location empty.`);
  }

  await page.locator('#incident\\.contact_type').selectOption({ label: draft.channel });
  await page.locator('#incident\\.category').selectOption({ label: draft.category });
  const subcategoryField = page.locator('#incident\\.subcategory');
  let selectedSubcategory = '';
  if (draft.subcategory) {
    const subcategorySelected = await selectOptionWhenAvailable(page, '#incident\\.subcategory', draft.subcategory);
    if (!subcategorySelected) {
      console.warn(`Subcategory "${draft.subcategory}" is unavailable for ${draft.category}; leaving -- None -- selected.`);
      await subcategoryField.selectOption({ label: '-- None --' });
    } else {
      selectedSubcategory = (await subcategoryField.locator('option:checked').innerText()).trim();
    }
  } else {
    await subcategoryField.selectOption({ label: '-- None --' });
  }
  await page.locator('#incident\\.state').selectOption({ label: draft.state });
  if (draft.state === 'On Hold' && draft.holdReason) {
    const holdReason = page.locator('#incident\\.hold_reason');
    try {
      await holdReason.waitFor({ state: 'visible', timeout: 5000 });
      if (!await selectOptionWhenAvailable(page, '#incident\\.hold_reason', draft.holdReason)) {
        console.warn(`On hold reason "${draft.holdReason}" is unavailable; leaving -- None -- selected.`);
      }
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error;
      console.warn('On hold reason field did not become visible; leaving its default selection.');
    }
  }
  await page.locator('#incident\\.impact').selectOption({ label: draft.impact });
  await page.locator('#incident\\.urgency').selectOption({ label: draft.urgency });
  await page.locator(`input[type="radio"][value="${draft.vip ? 'VIP' : 'Non VIP'}"]`).check();

  await fillAndSelectReference(page, '#sys_display\\.incident\\.assignment_group', draft.assignmentGroup, CONFIG.assignmentGroup, { useLookup: true });
  await fillAndSelectReference(page, '#sys_display\\.incident\\.assigned_to', draft.assignedTo, '', { allowBlank: true });

  await page.locator('#incident\\.short_description').fill(draft.shortDescription);
  const affectedService = selectedSubcategory ? `${draft.category} - ${selectedSubcategory}` : draft.category;
  const description = draft.description.replace(/Affected Service:\n[\s\S]*$/, `Affected Service:\n${affectedService}`);
  await page.locator('#incident\\.description').fill(description);
  await activateFormTab(page, 'Notes');
  await page.locator('#incident\\.work_notes').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#incident\\.work_notes').fill(draft.workNotes);

  if (draft.state === 'Resolved') {
    await fillResolutionInformation(page, draft);
  }
}

async function fillResolutionInformation(page, draft) {
  await activateFormTab(page, 'Resolution Information');

  const closeCode = page.locator('#incident\\.close_code');
  const closeNotes = page.locator('#incident\\.close_notes');
  await closeCode.waitFor({ state: 'visible', timeout: 10000 });
  await closeNotes.waitFor({ state: 'visible', timeout: 10000 });

  const optionLabels = await closeCode.locator('option').allTextContents();
  const matchingLabel = optionLabels.find((label) => normalize(label) === normalize(draft.resolutionCode));
  if (!matchingLabel) {
    throw new Error(`Resolution code "${draft.resolutionCode}" is not available in the Resolution Information tab.`);
  }
  await closeCode.selectOption({ label: matchingLabel.trim() });
  await closeNotes.fill(draft.resolutionNotes);
}

async function activateFormTab(page, tabName) {
  const tab = page.getByText(tabName, { exact: true }).filter({ visible: true }).last();
  await tab.waitFor({ state: 'visible', timeout: 10000 });
  await tab.click();
}

async function selectOptionWhenAvailable(page, selector, label, timeout = 10000) {
  const select = page.locator(selector);
  const expected = normalize(label);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const optionLabels = await select.locator('option').allTextContents();
    const matchingLabel = optionLabels.find((optionLabel) => normalize(optionLabel) === expected);
    if (matchingLabel !== undefined) {
      await select.selectOption({ label: matchingLabel.trim() });
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function fillAndSelectReference(page, selector, candidate, fallback, { allowBlank = false, useLookup = false } = {}) {
  const field = page.locator(selector);
  const attempt = async (value) => {
    if (!value) return false;
    await field.fill(value);
    const dataRef = await field.getAttribute('data-ref');
    const completer = await field.getAttribute('data-completer');
    const suggestionListId = await field.getAttribute('aria-owns')
      || (completer === 'AJAXTableCompleter' && dataRef ? `AC.${dataRef}` : null);
    const suggestions = suggestionListId
      ? page.locator(`[id="${suggestionListId}"] [role="option"]:visible, [id="${suggestionListId}"] li:visible, [role="option"]:visible, .ac_results li:visible`)
      : page.locator('[role="option"]:visible, .ac_results li:visible');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const count = await suggestions.count();
      const labels = [];
      for (let index = 0; index < count; index += 1) {
        const suggestion = suggestions.nth(index);
        labels.push(await suggestion.innerText().catch(() => ''));
      }
      const matchIndex = bestReferenceMatchIndex(labels, value);
      if (matchIndex >= 0) {
        await suggestions.nth(matchIndex).click();
        return waitForReferenceValue(page, field);
      }
      await page.waitForTimeout(200);
    }
    if (useLookup) return selectReferenceFromLookup(page, field, value);
    return false;
  };

  if (await attempt(candidate)) return true;
  if (fallback && normalize(fallback) !== normalize(candidate) && await attempt(fallback)) return true;
  if (allowBlank || !fallback) {
    await field.fill('');
    await field.press('Tab');
    return false;
  } else {
    throw new Error(`No ServiceNow reference was found for ${candidate} or fallback ${fallback}.`);
  }
}

async function selectReferenceFromLookup(page, field, value) {
  const fieldId = await field.getAttribute('id');
  if (!fieldId?.startsWith('sys_display.')) return false;

  const referenceName = fieldId.slice('sys_display.'.length);
  const lookup = page.locator(`[id="lookup.${referenceName}"]`);
  if (!await lookup.isVisible().catch(() => false)) return false;

  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5000 }).catch((error) => {
      if (error?.name === 'TimeoutError') return null;
      throw error;
    }),
    lookup.click(),
  ]);
  if (!popup) return false;
  try {
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch((error) => {
      if (error?.name !== 'TimeoutError') throw error;
    });

    const search = popup.locator('input[aria-label="Search"]:visible').first();
    await search.waitFor({ state: 'visible', timeout: 15000 });
    await search.fill(value);
    await search.press('Enter');

    const records = popup.locator('a.glide_ref_item_link');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !popup.isClosed()) {
      const count = await records.count();
      const labels = [];
      for (let index = 0; index < count; index += 1) {
        const record = records.nth(index);
        labels.push(await record.innerText().catch(() => ''));
      }
      const matchIndex = bestReferenceMatchIndex(labels, value);
      if (matchIndex >= 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          await records.nth(matchIndex).click({ timeout: Math.min(1500, remaining) });
          return waitForReferenceValue(page, field);
        } catch (error) {
          if (error?.name !== 'TimeoutError') throw error;
        }
      }
      await popup.waitForTimeout(250);
    }
    return false;
  } finally {
    if (!popup.isClosed()) await popup.close();
  }
}

function bestReferenceMatchIndex(labels, value) {
  const target = normalize(value);
  const normalized = labels.map(normalize);
  for (const predicate of [
    (label) => label === target,
    (label) => label.startsWith(target),
    (label) => label.includes(target),
  ]) {
    const matches = normalized.reduce((indices, label, index) => {
      if (label && predicate(label)) indices.push(index);
      return indices;
    }, []);
    if (matches.length === 1) return matches[0];
  }
  return -1;
}

async function waitForReferenceValue(page, field) {
  const fieldId = await field.getAttribute('id');
  if (!fieldId?.startsWith('sys_display.')) return false;

  const referenceValue = page.locator(`[id="${fieldId.slice('sys_display.'.length)}"]`);
  await referenceValue.waitFor({ state: 'attached', timeout: 5000 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await referenceValue.inputValue().catch(() => '')) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

function trackerColumns() { return [
  'Ticket NO', 'Snow Ticket', 'Report Date', 'Report Time', 'Ticket Date', 'Ticket Time', 'Pelapor', 'Nama User', 'VIP', 'Cyber', 'Entity', 'Sumber Laporan', 'Judul email', 'Deskripsi Laporan', 'Urgency', 'Impact', 'Priority', 'Status', 'Pending With', 'Pending Reason', 'Next follow up schedule', 'Category', 'Service Category', 'Request Type', 'Assigned to', 'LastUpdateBy', 'Comments and Work notes', 'Service Restored Date', 'Service Restored Time', 'Resolved Date', 'Resolved Time', 'Closed Date', 'Closed Time', '.', 'Duration', 'FCR (Y/N)', '…', '_extra_38', '_extra_39'
]; }

function loadSelectedTrackerRows() {
  return loadPastedTrackerRows(CONFIG.trackerTextPath);
}

function loadPastedTrackerRows(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Tracker text file was not found: ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const cellsByRow = raw.trimStart().startsWith('|')
    ? raw.split(/\r?\n/).map(parseMarkdownTableRow)
    : parseDelimitedRecords(raw, '\t');

  return cellsByRow
    .filter((cells) => cells.length && /^\d{8,}$/.test(clean(cells[0])))
    .map((cells, index) => {
      const row = Object.fromEntries(trackerColumns().map((header, column) => [header, cleanTrackerCell(cells[column] || '')]));
      return { ...row, __rowNumber__: `text:${index + 1}`, __source__: 'txt' };
    });
}

// Handles Excel's tab-separated clipboard format, including cells quoted by
// Excel because they contain line breaks or quote characters.
function parseDelimitedRecords(raw, delimiter) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]; const next = raw[i + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}
function parseMarkdownTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  return trimmed.slice(1).replace(/\|\s*$/, '').split('|').map(cleanTrackerCell);
}

function cleanTrackerCell(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&#x20;/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .trim();
}
function parseTrainingCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const firstLine = raw.split(/\r?\n/, 1)[0] || '';
  const delimiter = countUnquotedDelimiter(firstLine, ',') > countUnquotedDelimiter(firstLine, ';') ? ',' : ';';
  const [headerRow, ...dataRows] = parseDelimitedRecords(raw, delimiter);
  if (!headerRow?.length) throw new Error(`Training CSV has no header row: ${filePath}`);
  const headers = headerRow.map((header) => header.trim());
  return dataRows
    .filter((row) => row.some((value) => clean(value)))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

function countUnquotedDelimiter(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') index += 1;
    else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) count += 1;
  }
  return count;
}

function hasDatasetColumn(records, ...names) {
  if (!records.length) return false;
  const available = new Set(Object.keys(records[0]).map(normalizeDatasetField));
  return names.some((name) => available.has(normalizeDatasetField(name)));
}

function datasetField(record, ...names) {
  const wanted = new Set(names.map(normalizeDatasetField));
  const entry = Object.entries(record).find(([name, value]) => wanted.has(normalizeDatasetField(name)) && clean(value));
  return entry?.[1] || '';
}

function normalizeDatasetField(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findLikelyDuplicate(training, name, location, issue) {
  const topic = normalize(issue).split(/\s+/).filter((word) => word.length > 4).slice(0, 5);
  return training.find((record) => {
    const user = datasetField(record, 'Business_User', 'Business User', 'u_business_user')
      || datasetField(record, 'Caller', 'caller_id');
    const historicalLocation = datasetField(record, 'Location', 'location');
    const searchable = `${datasetField(record, 'Short_description', 'short_description')} ${datasetField(record, 'Description', 'description')}`;
    const sameLocation = historicalLocation && normalize(historicalLocation) === normalize(location);
    return normalize(user) === normalize(name) && sameLocation && topic.some((word) => normalize(searchable).includes(word));
  });
}

function recommendLocation(training, actualUser, caller, entity) {
  if (!entity) return { value: '', source: 'none' };

  const userName = normalize(actualUser);
  const callerName = normalize(caller);
  const userMatches = userName
    ? training.filter((record) =>
      normalize(datasetField(record, 'Business_User', 'Business User', 'u_business_user', 'Caller', 'caller_id')) === userName
      && datasetField(record, 'Location', 'location'))
    : [];
  const callerMatches = callerName
    ? training.filter((record) =>
      normalize(datasetField(record, 'Caller', 'caller_id')) === callerName
      && datasetField(record, 'Location', 'location'))
    : [];
  const matchingRecords = userMatches.length ? userMatches : callerMatches;
  const normalizedEntity = normalize(entity);
  const entityMatches = matchingRecords.filter((record) => {
    const location = normalize(datasetField(record, 'Location', 'location'));
    return location.includes(normalizedEntity) || normalizedEntity.includes(location);
  });
  const candidates = (entityMatches.length ? entityMatches : matchingRecords)
    .map((record) => clean(datasetField(record, 'Location', 'location')));
  if (!candidates.length) return { value: entity, source: 'tracker' };

  const counts = new Map();
  for (const candidate of candidates) {
    const key = normalize(candidate);
    const existing = counts.get(key) || { value: candidate, count: 0 };
    existing.count += 1;
    counts.set(key, existing);
  }
  const ranked = [...counts.values()].sort((left, right) => right.count - left.count);
  if (ranked.length > 1 && ranked[0].count === ranked[1].count) {
    return { value: entity, source: 'tracker' };
  }
  return { value: ranked[0].value, source: 'dataset' };
}

function formatWorkNote(note, date, time) {
  const body = stripInternalReferences(note) || 'Investigation recorded.';
  if (/^\[?\d{1,2}[\/-]\d{1,2}/.test(body)) return body;
  const stamp = `${normalizeDateForNote(date)} ${String(time || '').replace(/\s*(AM|PM)$/i, '')}`.trim();
  return `[${stamp || localToday()}] ${body}`;
}

function stripInternalReferences(value) {
  return clean(value).replace(/\bINC\d+\b/gi, '').replace(/\b20\d{9,}\b/g, '').replace(/\s{2,}/g, ' ').trim();
}
function mapState(value) {
  return /resolved/i.test(value) ? 'Resolved'
    : /hold|pending/i.test(value) ? 'On Hold'
      : /progress/i.test(value) ? 'In Progress'
        : 'New';
}
function mapHoldReason(pendingReason, pendingWith = '') {
  const text = normalize(`${pendingWith} ${pendingReason}`);
  if (/\b(caller|user|requester|customer)\b/.test(text)) return 'Awaiting Caller';
  if (/\b(change|cab)\b/.test(text)) return 'Awaiting Change';
  if (/\bproblem\b/.test(text)) return 'Awaiting Problem';
  if (/\b(vendor|supplier|manufacturer|lenovo)\b/.test(text)) return 'Awaiting Vendor';
  return '';
}
function mapCategory(value, context = '') {
  const source = clean(value);
  const normalized = normalize(source);
  if (normalized === 'request') return 'Service Request';
  if (normalized === 'service') {
    const text = normalize(context);
    const isQuestion = /\b(inquiry|question|how to|information)\b/.test(text);
    const isRequest = /\b(access|install|license|account|deploy|change|permission|request)\b/.test(text);
    return isQuestion && !isRequest ? 'Inquiry / Help' : 'Service Request';
  }
  const validCategories = [
    'Software',
    'Hardware',
    'Network',
    'Database',
    'Cloud Management',
    'Service Request',
    'Security Incident',
    'Inquiry / Help',
  ];
  return validCategories.find((category) => normalize(category) === normalized) || 'Inquiry / Help';
}
function isMeetingRoomRequest(category, context) {
  if (normalize(category) !== 'service request') return false;
  return /\b(?:meeting\s*rooms?|room\s*meeting|ruang\s*(?:meeting|rapat))\b/.test(normalize(context));
}
function mapChannel(value) {
  return /whats\s?app?|teams?|chat/i.test(value) ? 'Chat'
    : /walk/i.test(value) ? 'Walk-in'
      : /email/i.test(value) ? 'Email'
        : /phone/i.test(value) ? 'Phone'
          : 'Self-service';
}
function mapSubcategory(category, value) {
  const source = clean(value);
  const normalized = normalize(source);
  const categoryName = normalize(category);
  if (categoryName === 'hardware' && /^(printer|printing)$/.test(normalized)) return 'Printing';
  if (categoryName === 'network' && /^(wi[\s-]?fi|wireless)$/.test(normalized)) return 'Wireless';
  if (categoryName === 'software' && /^(adobe|pdf|adobe\s*\/\s*pdf)$/.test(normalized)) return 'Adobe / PDF';
  if (categoryName === 'software' && /^(prisma|browser)$/.test(normalized)) return 'Browser / Prisma';
  if (categoryName === 'hardware' && normalized === 'monitor') return 'Monitor';
  if (categoryName === 'software' && normalized === 'email') return 'Email';
  return source;
}
function mapLevel(value) { return /tinggi|high/i.test(value) ? '1 - High' : /sedang|medium/i.test(value) ? '2 - Medium' : '3 - Low'; }
function isVip(value) { return /^(y|yes|vip|true)$/i.test(clean(value)); }
function normalizeDate(value) {
  const text = clean(value); if (!text) return '';
  const named = text.match(/(\d{1,2})[\s\/-]([A-Za-z]{3,9})[\s\/-](\d{2,4})/);
  if (named) {
    const [, day, monthName, rawYear] = named;
    const month = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[monthName.slice(0, 3).toLowerCase()];
    const year = Number(rawYear) < 100 ? 2000 + Number(rawYear) : Number(rawYear);
    return month ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
  }
  const numeric = text.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (!numeric) return '';
  const [, a, b, rawYear] = numeric;
  const year = Number(rawYear) < 100 ? 2000 + Number(rawYear) : Number(rawYear);
  const dayFirst = Number(a) > 12 || (Number(b) <= 12 && Number(a) > Number(b));
  const day = dayFirst ? a : b; const month = dayFirst ? b : a;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function normalizeDateForNote(value) { const iso = normalizeDate(value); return iso ? iso.split('-').reverse().join('/') : ''; }
function localToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TIMEZONE || 'Asia/Jakarta' }).format(new Date()); }
function toEnglishish(value) { return clean(value).replace(/[.!?]+$/, '') || 'reported service issue'; }
function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function normalize(value) { return clean(value).toLowerCase(); }
function mustEnv(name) { if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`); return process.env[name]; }
function writeJson(filePath, value) { fs.writeFileSync(filePath, JSON.stringify(value, null, 2)); }
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}















