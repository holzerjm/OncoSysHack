/**
 * RAG the City — Judging Order + Scoring Sheet
 * ---------------------------------------------------------------------------
 * Reads team submissions from "Form Responses 1", groups them by challenge
 * track, randomly orders each track, and writes a formatted judging running
 * order — with a scoring block per judge — into the "Judging" tab.
 *
 * Scoring follows the RAG the City judge card: four criteria, 1-4 integers each,
 * 16 points max, averaged across judges, ranked within a track only.
 *
 * Menu (appears after reload): "Judging"
 *   - Shuffle all tracks          : brand new random order for every track
 *   - Add new teams only          : keeps the current order, appends late entries
 *   - Shuffle one track...        : reshuffles a single track, leaves others alone
 *   - Clear judging order         : wipes the Judging tab
 *
 * Scores, judge names, advance ticks and notes are keyed to the team name and
 * carried over on every regeneration, so reshuffling mid-event never loses data.
 */

var CONFIG = {
  sourceSheet: 'Form Responses 1',
  targetSheet: 'Judging',

  // Source layout (1-based column numbers).
  headerRows: 1,
  colTeam: 3,      // C = Team Name
  colMembers: 4,   // D = Team Members
  colTrack: 10,    // J = Select your challenge track

  // Scoring
  judgeCount: 4,           // score columns per team; blank judges are ignored in the average
  minScore: 1,
  maxScore: 4,
  showAdvanceColumn: true, // "Advance to final?" tick — round 1 only, per the judge card

  // Behaviour
  dedupeByTeamName: true,  // a team that submits twice is judged once (latest wins)
  stripEmails: true,       // drop email addresses out of the Team Members text
  unassignedLabel: 'No track selected',

  // Presentation — colours mirror the conditional formatting on column J.
  docTitle: 'RAG the City — Judging Order & Scores',
  resultsLabel: 'Result',
  trackColors: {
    'Track 1': '#f6b26b',
    'Track 2': '#b7e1cd'
  },
  defaultTrackColor: '#d9d9d9',

  // Maps the form's track wording onto the judge card's A/B lettering, so the
  // "Track Excellence" criterion shows the right anchors for each section.
  trackRubricLetter: {
    'Track 1': 'A',
    'Track 2': 'B'
  }
};

/** The judge card, criterion by criterion. Column labels are kept short; the
 *  full wording lives in the cell note on each header. */
var CRITERIA = [
  {
    label: 'RAG',
    title: '1 · RAG Quality & Grounding — both tracks',
    note: "4 = every answer cited to specific data, precise retrieval, abstains honestly (“I don't know”)\n" +
          '1 = often wrong or hallucinated, no citations'
  },
  {
    label: 'Track',
    title: '2 · Track Excellence — your track only',
    note: 'Score against this team’s own track. Never compare Track A to Track B.',
    noteByLetter: {
      A: 'Track A · Engine\n' +
         '4 = sophisticated architecture, measurably beats naive RAG — can show the numbers\n' +
         '1 = stuffs the data into one prompt, no error handling',
      B: 'Track B · Experience\n' +
         '4 = intuitive, delightful; a non-technical resident would use it unprompted; honest about sources\n' +
         '1 = raw text output, needs technical knowledge'
    }
  },
  {
    label: 'Innov',
    title: '3 · Innovation — both tracks',
    note: "4 = genuinely new — something the judges haven't seen before\n" +
          '1 = standard LangChain tutorial implementation'
  },
  {
    label: 'Pres',
    title: '4 · Presentation — both tracks',
    note: '4 = compelling story, live demo with real queries, explains WHY, lands on time\n' +
          '1 = unclear demo, jargon, hard to follow'
  }
];

var SECTION_COUNT_RE = /\s+—\s+\d+\s+teams?$/;   // " — 4 teams" suffix on section titles
var RUNTIME_WARNINGS = [];                       // non-fatal problems raised while writing

/* ------------------------------------------------------------------ menu -- */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Judging')
    .addItem('Shuffle all tracks (new random order)', 'generateJudgingOrder')
    .addItem('Add new teams only (keep current order)', 'addNewTeamsToJudgingOrder')
    .addItem('Shuffle one track...', 'shuffleSingleTrack')
    .addSeparator()
    .addItem('Clear judging order', 'clearJudgingOrder')
    .addToUi();
}

/** Full reshuffle: every track gets a fresh random order. Scores travel with
 *  their team, but the running order changes, so it asks first once scoring
 *  has started. */
function generateJudgingOrder() {
  var scored = countScoredTeams_(readExistingState_());
  if (scored) {
    var ui = ui_();
    if (ui) {
      var ok = ui.alert('Shuffle all tracks',
        scored + ' team(s) already have scores.\n\nScores, notes and advance ticks stay with their team, ' +
        'but the running order will change. Continue?',
        ui.ButtonSet.YES_NO);
      if (ok !== ui.Button.YES) { return; }
    }
  }
  rebuild_({ shuffleAll: true }, 'Shuffled all tracks');
}

/** Keeps the running order that is already on the Judging tab and appends
 *  any team that has submitted since, in random order, at the end of its track. */
function addNewTeamsToJudgingOrder() {
  rebuild_({ shuffleAll: false }, 'Added new teams');
}

/** Reshuffles one track; every other track keeps its current order. */
function shuffleSingleTrack() {
  var ui = ui_();
  if (!ui) { throw new Error('Run this from the spreadsheet menu, not the script editor.'); }

  var tracks = sortTracks_(Object.keys(groupByTrack_(readSubmissions_().teams)));
  if (!tracks.length) { notify_('No submissions found in "' + CONFIG.sourceSheet + '".'); return; }

  var menu = tracks.map(function (t, i) { return (i + 1) + ') ' + t; }).join('\n');
  var answer = ui.prompt('Reshuffle one track',
    'Which track should be reshuffled?\n\n' + menu + '\n\nEnter a number:',
    ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) { return; }

  var pick = parseInt(String(answer.getResponseText()).trim(), 10);
  if (!(pick >= 1 && pick <= tracks.length)) {
    ui.alert('"' + answer.getResponseText() + '" is not one of the listed numbers. Nothing changed.');
    return;
  }
  rebuild_({ shuffleAll: false, shuffleTrack: tracks[pick - 1] },
           'Reshuffled ' + shortTrack_(tracks[pick - 1]));
}

/** Empties the Judging tab. */
function clearJudgingOrder() {
  var ui = ui_();
  if (ui) {
    var scored = countScoredTeams_(readExistingState_());
    var ok = ui.alert('Clear judging order',
      'This erases the "' + CONFIG.targetSheet + '" tab' +
      (scored ? ', including scores for ' + scored + ' team(s)' : ', including any judge notes') +
      '. Continue?',
      ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) { return; }
  }
  resetSheet_(targetSheet_());
  notify_('Judging tab cleared.');
}

/* ------------------------------------------------------------- pipeline -- */

function rebuild_(opts, actionLabel) {
  RUNTIME_WARNINGS = [];
  var read = readSubmissions_();
  if (!read.teams.length) {
    notify_('No teams found in "' + CONFIG.sourceSheet + '". Nothing written.');
    return;
  }

  var previous = readExistingState_();
  var groups = buildGroups_(read.teams, previous.order, opts);
  writeJudging_(groups, previous);

  var trackNames = sortTracks_(Object.keys(groups));
  var counts = trackNames.map(function (t) { return shortTrack_(t) + ': ' + groups[t].length; }).join('  ·  ');
  var msg = actionLabel + ' — ' + read.teams.length + ' teams across ' + trackNames.length +
            ' track' + (trackNames.length === 1 ? '' : 's') + '.\n' + counts;

  var carried = countScoredTeams_(previous);
  if (carried) { msg += '\nScores carried over for ' + carried + ' team(s).'; }
  var warnings = read.warnings.concat(RUNTIME_WARNINGS);
  if (warnings.length) { msg += '\n\nHeads up:\n· ' + warnings.join('\n· '); }
  notify_(msg);
}

/** Reads the form responses into {teams: [...], warnings: [...]}. */
function readSubmissions_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.sourceSheet);
  if (!sheet) { throw new Error('Sheet "' + CONFIG.sourceSheet + '" was not found.'); }

  var warnings = [];
  var width = Math.max(CONFIG.colTeam, CONFIG.colMembers, CONFIG.colTrack);
  if (sheet.getMaxColumns() < width) {
    throw new Error('"' + CONFIG.sourceSheet + '" has fewer than ' + width + ' columns.');
  }

  var header = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  checkHeader_(header, CONFIG.colTeam, 'team name', warnings);
  checkHeader_(header, CONFIG.colMembers, 'member', warnings);
  checkHeader_(header, CONFIG.colTrack, 'track', warnings);

  var lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.headerRows) { return { teams: [], warnings: warnings }; }

  var rows = sheet.getRange(CONFIG.headerRows + 1, 1, lastRow - CONFIG.headerRows, width).getDisplayValues();
  var teams = [];
  var blanks = 0;

  rows.forEach(function (row, i) {
    var name = String(row[CONFIG.colTeam - 1] || '').trim();
    if (!name) { if (String(row.join('')).trim()) { blanks++; } return; }
    teams.push({
      name: name,
      key: key_(name),
      members: formatMembers_(row[CONFIG.colMembers - 1]),
      track: String(row[CONFIG.colTrack - 1] || '').trim() || CONFIG.unassignedLabel,
      row: CONFIG.headerRows + 1 + i
    });
  });

  if (blanks) { warnings.push(blanks + ' response(s) had no team name and were skipped.'); }

  if (CONFIG.dedupeByTeamName) {
    var byKey = {};
    var dropped = [];
    teams.forEach(function (t) {
      if (byKey[t.key]) { dropped.push(t.name); }
      byKey[t.key] = t;                       // later submission wins
    });
    if (dropped.length) {
      warnings.push('Duplicate submissions kept once (latest used): ' + unique_(dropped).join(', ') + '.');
      teams = teams.filter(function (t) { return byKey[t.key] === t; });
    }
  }

  return { teams: teams, warnings: warnings };
}

function checkHeader_(header, col, expectedWord, warnings) {
  var actual = String(header[col - 1] || '').toLowerCase();
  if (actual.indexOf(expectedWord) === -1) {
    warnings.push('Column ' + colLetter_(col) + ' is "' + (header[col - 1] || '(blank)') +
                  '", expected something containing "' + expectedWord + '" — check CONFIG if the form changed.');
  }
}

/** Applies the ordering rules to produce {track: [team, ...]}. */
function buildGroups_(teams, existingOrder, opts) {
  var groups = groupByTrack_(teams);

  Object.keys(groups).forEach(function (track) {
    var list = groups[track];
    var reshuffle = opts.shuffleAll || (opts.shuffleTrack && opts.shuffleTrack === track);
    var previous = existingOrder[track];

    if (reshuffle || !previous || !previous.length) {
      groups[track] = shuffle_(list);
      return;
    }

    var pending = {};
    list.forEach(function (t) { pending[t.key] = t; });

    var ordered = [];
    previous.forEach(function (k) {
      if (pending[k]) { ordered.push(pending[k]); delete pending[k]; }
    });

    var latecomers = Object.keys(pending).map(function (k) { return pending[k]; });
    groups[track] = ordered.concat(shuffle_(latecomers));
  });

  return groups;
}

function groupByTrack_(teams) {
  var groups = {};
  teams.forEach(function (t) {
    if (!groups[t.track]) { groups[t.track] = []; }
    groups[t.track].push(t);
  });
  return groups;
}

/* --------------------------------------------------------------- layout -- */

/** Column plan for the Judging tab, derived from CONFIG.judgeCount. */
function layout_() {
  var L = { colOrder: 1, colTeam: 2, colMembers: 3, judges: [] };
  var c = 4;
  for (var j = 0; j < CONFIG.judgeCount; j++) {
    L.judges.push({ first: c, last: c + CRITERIA.length, total: c + CRITERIA.length });
    c += CRITERIA.length + 1;
  }
  L.resultFirst = c;
  L.colJudgesIn = c++;
  L.colAvg = c++;
  L.colRank = c++;
  if (CONFIG.showAdvanceColumn) { L.colAdvance = c++; }
  L.colNotes = c++;
  L.width = c - 1;
  L.maxTotal = CRITERIA.length * CONFIG.maxScore;
  return L;
}

/* -------------------------------------------------------------- reading -- */

/** Parses whatever is already on the Judging tab: the running order per track,
 *  the judge names per track, and every hand-entered cell per team. */
function readExistingState_() {
  var state = { order: {}, judges: {}, teams: {} };
  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.targetSheet);
  if (!sheet || sheet.getLastRow() < 1) { return state; }

  var rows = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn() || 1).getValues();
  var track = null;
  var section = null;

  rows.forEach(function (row, i) {
    var a = String(row[0] === null || row[0] === undefined ? '' : row[0]).trim();
    var b = String(row[1] === null || row[1] === undefined ? '' : row[1]).trim();
    if (!a) { return; }

    if (a === '#') {                                   // column-header row
      section = readSectionLayout_(rows[i - 1] || [], row);
      if (track && section.judgeNames.length) { state.judges[track] = section.judgeNames; }
      return;
    }
    if (a === CONFIG.docTitle || a.indexOf('Generated') === 0) { return; }

    if (/^\d+$/.test(a)) {                             // a team row
      if (!b || !track) { return; }
      var k = key_(b);
      if (!state.order[track]) { state.order[track] = []; }
      state.order[track].push(k);
      state.teams[k] = readTeamRow_(row, section);
      return;
    }

    track = a.replace(SECTION_COUNT_RE, '').trim();    // a section title
    section = null;
  });

  return state;
}

/** Works out where the judge blocks and the result columns sit in an existing
 *  section, so hand-entered data survives a layout change. */
function readSectionLayout_(groupRow, headerRow) {
  var section = { judgeNames: [], judgeStarts: [], colAdvance: 0, colNotes: 0 };

  for (var c = 3; c < groupRow.length; c++) {
    var label = String(groupRow[c] || '').trim();
    if (!label || label === CONFIG.resultsLabel) { continue; }
    if (section.judgeStarts.length >= CONFIG.judgeCount) { break; }
    section.judgeNames.push(label);
    section.judgeStarts.push(c + 1);                   // 1-based
  }


  headerRow.forEach(function (cell, c) {
    var label = String(cell || '').trim().toLowerCase();
    if (label.indexOf('advance') === 0) { section.colAdvance = c + 1; }
    if (label === 'notes') { section.colNotes = c + 1; }
  });

  return section;
}

/** Pulls the hand-entered cells (scores, advance tick, notes) out of one row. */
function readTeamRow_(row, section) {
  var entry = { scores: [], advance: false, notes: '' };
  if (!section) { return entry; }

  section.judgeStarts.forEach(function (start) {
    var scores = [];
    for (var k = 0; k < CRITERIA.length; k++) {
      var v = row[start - 1 + k];
      scores.push(typeof v === 'number' ? v : '');
    }
    entry.scores.push(scores);
  });

  if (section.colAdvance) { entry.advance = row[section.colAdvance - 1] === true; }
  if (section.colNotes) { entry.notes = String(row[section.colNotes - 1] || ''); }
  return entry;
}

function countScoredTeams_(state) {
  var n = 0;
  Object.keys(state.teams || {}).forEach(function (k) {
    var e = state.teams[k];
    var any = (e.scores || []).some(function (judge) {
      return judge.some(function (v) { return v !== '' && v !== null; });
    });
    if (any) { n++; }
  });
  return n;
}

/* -------------------------------------------------------------- writing -- */

function writeJudging_(groups, previous) {
  var sheet = targetSheet_();
  var L = layout_();
  resetSheet_(sheet);
  ensureSize_(sheet, L.width);

  var tracks = sortTracks_(Object.keys(groups));
  var total = tracks.reduce(function (n, t) { return n + groups[t].length; }, 0);
  var stamp = Utilities.formatDate(new Date(), SpreadsheetApp.getActive().getSpreadsheetTimeZone(),
                                   'MMM d, yyyy \'at\' h:mm a');

  var values = [];
  var titleRows = [];    // {row, color}
  var groupRows = [];    // {row, track}
  var headerRows = [];   // {row, track}
  var blocks = [];       // {row, count}

  values.push(blank_(L, CONFIG.docTitle));
  values.push(blank_(L, 'Generated ' + stamp + '  ·  ' + total + ' teams  ·  ' + tracks.length +
                        ' track' + (tracks.length === 1 ? '' : 's') + '  ·  ' +
                        CRITERIA.length + ' criteria × ' + CONFIG.maxScore + ' points = ' + L.maxTotal +
                        ' max, averaged across judges  ·  reshuffle from the "Judging" menu'));
  values.push(blank_(L));

  tracks.forEach(function (track) {
    var list = groups[track];

    titleRows.push({ row: values.length + 1, color: trackColor_(track) });
    values.push(blank_(L, track + ' — ' + list.length + ' team' + (list.length === 1 ? '' : 's')));

    groupRows.push({ row: values.length + 1, track: track });
    values.push(groupHeaderRow_(L, previous.judges[track]));

    headerRows.push({ row: values.length + 1, track: track });
    values.push(columnHeaderRow_(L));

    var first = values.length + 1;
    blocks.push({ row: first, count: list.length, track: track });
    list.forEach(function (team, i) {
      values.push(teamRow_(L, team, i + 1, first, first + list.length - 1, previous.teams[team.key]));
    });

    values.push(blank_(L));
  });

  values.pop();   // trailing spacer
  ensureSize_(sheet, L.width, values.length);
  sheet.getRange(1, 1, values.length, L.width).setValues(values);

  styleSheet_(sheet, L, values.length, titleRows, groupRows, headerRows, blocks);

  try { SpreadsheetApp.getActive().setActiveSheet(sheet); } catch (e) { /* headless run */ }
}

function blank_(L, firstCell) {
  var row = [];
  for (var i = 0; i < L.width; i++) { row.push(''); }
  if (firstCell) { row[0] = firstCell; }
  return row;
}

/** Row of merged judge names + the "Result" banner. */
function groupHeaderRow_(L, previousNames) {
  var row = blank_(L);
  L.judges.forEach(function (judge, j) {
    var name = previousNames && previousNames[j] ? previousNames[j] : 'Judge ' + (j + 1);
    row[judge.first - 1] = name;
  });
  row[L.resultFirst - 1] = CONFIG.resultsLabel;
  return row;
}

function columnHeaderRow_(L) {
  var row = blank_(L);
  row[L.colOrder - 1] = '#';
  row[L.colTeam - 1] = 'Team Name';
  row[L.colMembers - 1] = 'Team Members';
  L.judges.forEach(function (judge) {
    CRITERIA.forEach(function (c, k) { row[judge.first - 1 + k] = c.label; });
    row[judge.total - 1] = '/' + L.maxTotal;
  });
  row[L.colJudgesIn - 1] = 'Judges';
  row[L.colAvg - 1] = 'Avg / ' + L.maxTotal;
  row[L.colRank - 1] = 'Rank';
  if (L.colAdvance) { row[L.colAdvance - 1] = 'Advance?'; }
  row[L.colNotes - 1] = 'Notes';
  return row;
}

/** One team: order, name, members, carried-over scores, and the live formulas. */
function teamRow_(L, team, position, firstRow, lastRow, carried) {
  var r = firstRow + position - 1;
  var row = blank_(L);
  row[L.colOrder - 1] = position;
  row[L.colTeam - 1] = team.name;
  row[L.colMembers - 1] = team.members;

  var totalRefs = [];
  L.judges.forEach(function (judge, j) {
    var scores = (carried && carried.scores[j]) || [];
    for (var k = 0; k < CRITERIA.length; k++) {
      var v = scores[k];
      row[judge.first - 1 + k] = (typeof v === 'number') ? v : '';
    }
    var span = a1_(judge.first, r) + ':' + a1_(judge.last - 1, r);
    // Running sum; a trailing "*" marks an incomplete card, which keeps it out
    // of the average until all four criteria are in.
    row[judge.total - 1] = '=IF(COUNT(' + span + ')=0,"",IF(COUNT(' + span + ')<' + CRITERIA.length +
                           ',SUM(' + span + ')&"*",SUM(' + span + ')))';
    totalRefs.push(a1_(judge.total, r));
  });

  var refs = totalRefs.join(',');
  row[L.colJudgesIn - 1] = '=COUNT(' + refs + ')';
  row[L.colAvg - 1] = '=IFERROR(ROUND(AVERAGE(' + refs + '),2),"")';
  row[L.colRank - 1] = '=IF(' + a1_(L.colAvg, r) + '="","",RANK(' + a1_(L.colAvg, r) + ',' +
                       '$' + colLetter_(L.colAvg) + '$' + firstRow + ':$' + colLetter_(L.colAvg) + '$' + lastRow + '))';
  if (L.colAdvance) { row[L.colAdvance - 1] = (carried && carried.advance === true); }
  row[L.colNotes - 1] = (carried && carried.notes) || '';
  return row;
}

function styleSheet_(sheet, L, lastRow, titleRows, groupRows, headerRows, blocks) {
  setColumnWidths_(sheet, L);

  var all = sheet.getRange(1, 1, lastRow, L.width);
  all.setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle');

  sheet.getRange(1, 1, 1, L.width).merge()
    .setFontSize(16).setFontWeight('bold').setHorizontalAlignment('left');
  sheet.getRange(2, 1, 1, L.width).merge()
    .setFontSize(10).setFontColor('#666666').setFontStyle('italic');

  titleRows.forEach(function (t) {
    sheet.getRange(t.row, 1, 1, L.width).merge()
      .setBackground(t.color).setFontSize(12).setFontWeight('bold')
      .setHorizontalAlignment('left').setWrap(false);
    sheet.setRowHeight(t.row, 28);
  });

  groupRows.forEach(function (g) {
    var row = sheet.getRange(g.row, 1, 1, L.width);
    row.setBackground('#efefef').setFontWeight('bold').setHorizontalAlignment('center');
    L.judges.forEach(function (judge, j) {
      sheet.getRange(g.row, judge.first, 1, CRITERIA.length + 1).merge()
        .setBackground(j % 2 ? '#e8eaf6' : '#e3f2fd')
        .setNote('Rename this cell with the judge’s name — it is kept when the order is regenerated.');
    });
    sheet.getRange(g.row, L.resultFirst, 1, L.width - L.resultFirst + 1).merge().setBackground('#efefef');
  });

  headerRows.forEach(function (h) {
    var row = sheet.getRange(h.row, 1, 1, L.width);
    row.setFontWeight('bold').setBackground('#f3f3f3').setFontColor('#333333')
       .setHorizontalAlignment('center').setWrap(true)
       .setBorder(null, null, true, null, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange(h.row, L.colTeam, 1, 2).setHorizontalAlignment('left');
    setCriterionNotes_(sheet, L, h.row, h.track);
    sheet.setRowHeight(h.row, 30);
  });

  var scoreRanges = [];
  var rankRanges = [];

  blocks.forEach(function (b) {
    if (!b.count) { return; }
    var block = sheet.getRange(b.row, 1, b.count, L.width);
    block.setBorder(true, true, true, true, true, true, '#d9d9d9', SpreadsheetApp.BorderStyle.SOLID)
         .setVerticalAlignment('top');

    sheet.getRange(b.row, L.colOrder, b.count, 1).setHorizontalAlignment('center').setFontWeight('bold');
    sheet.getRange(b.row, L.colTeam, b.count, 1).setFontWeight('bold').setWrap(true);
    sheet.getRange(b.row, L.colMembers, b.count, 1).setWrap(true).setFontColor('#444444').setFontSize(9);


    L.judges.forEach(function (judge, j) {
      var scores = sheet.getRange(b.row, judge.first, b.count, CRITERIA.length);
      scores.setHorizontalAlignment('center').setNumberFormat('0')
            .setBackground(j % 2 ? '#f7f8fd' : '#f5fafe')
            .setDataValidation(scoreRule_(judge.first, b.row));
      scoreRanges.push(scores);

      sheet.getRange(b.row, judge.total, b.count, 1)
        .setHorizontalAlignment('center').setFontWeight('bold').setFontColor('#555555')
        .setBackground(j % 2 ? '#eceefa' : '#e9f4fd');
    });

    sheet.getRange(b.row, L.colJudgesIn, b.count, 1).setHorizontalAlignment('center').setFontColor('#777777');
    sheet.getRange(b.row, L.colAvg, b.count, 1)
      .setHorizontalAlignment('center').setFontWeight('bold').setNumberFormat('0.00');
    var rank = sheet.getRange(b.row, L.colRank, b.count, 1);
    rank.setHorizontalAlignment('center').setNumberFormat('0');
    rankRanges.push(rank);
    if (L.colAdvance) {
      sheet.getRange(b.row, L.colAdvance, b.count, 1).insertCheckboxes().setHorizontalAlignment('center');
    }
    sheet.getRange(b.row, L.colNotes, b.count, 1).setWrap(true);
  });

  sheet.setConditionalFormatRules(buildFormatRules_(scoreRanges, rankRanges));

  // Keeping "#, Team Name, Team Members" on screen while judges scroll across the
  // score columns is worth having, but never worth failing the whole write for.
  try {
    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(L.colMembers);
  } catch (e) {
    RUNTIME_WARNINGS.push('Could not freeze the team columns (' + e.message + '). Everything else was written.');
  }
}

function setColumnWidths_(sheet, L) {
  sheet.setColumnWidth(L.colOrder, 38);
  sheet.setColumnWidth(L.colTeam, 170);
  sheet.setColumnWidth(L.colMembers, 240);
  L.judges.forEach(function (judge) {
    for (var k = 0; k < CRITERIA.length; k++) { sheet.setColumnWidth(judge.first + k, 52); }
    sheet.setColumnWidth(judge.total, 46);
  });
  sheet.setColumnWidth(L.colJudgesIn, 56);
  sheet.setColumnWidth(L.colAvg, 68);
  sheet.setColumnWidth(L.colRank, 48);
  if (L.colAdvance) { sheet.setColumnWidth(L.colAdvance, 74); }
  sheet.setColumnWidth(L.colNotes, 220);
}

/** Hover notes carrying the judge card wording onto the header cells, written
 *  in one call per section. */
function setCriterionNotes_(sheet, L, row, track) {
  var letter = rubricLetter_(track);
  var notes = [];
  for (var i = 0; i < L.width; i++) { notes.push(''); }

  L.judges.forEach(function (judge) {
    CRITERIA.forEach(function (c, k) {
      var note = c.title + '\n\n' + c.note;
      if (c.noteByLetter) {
        note += '\n\n' + (letter ? c.noteByLetter[letter]
                                   : c.noteByLetter.A + '\n\n' + c.noteByLetter.B);
      }
      note += '\n\nWhole numbers ' + CONFIG.minScore + '-' + CONFIG.maxScore + ' only, no half points.';
      notes[judge.first - 1 + k] = note;
    });
    notes[judge.total - 1] =
      'Sum of this judge’s ' + CRITERIA.length + ' criteria, out of ' + L.maxTotal + '.\n\n' +
      'A trailing * means the card is incomplete — it stays out of the average until all ' +
      CRITERIA.length + ' scores are in.';
  });

  notes[L.colJudgesIn - 1] = 'How many judges have a complete card for this team.';
  notes[L.colAvg - 1] = 'Mean of the completed judge totals, out of ' + L.maxTotal + '.';
  notes[L.colRank - 1] = 'Rank within this track only. Never compare Track A to Track B.';
  if (L.colAdvance) {
    notes[L.colAdvance - 1] = 'Advance to the final? Round 1 only — the final is re-scored fresh.';
  }
  sheet.getRange(row, 1, 1, L.width).setNotes([notes]);
}

/** Whole numbers 1-4 only. */
function scoreRule_(firstCol, firstRow) {
  var cell = a1_(firstCol, firstRow);
  return SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied('=AND(ISNUMBER(' + cell + '),' + cell + '>=' + CONFIG.minScore + ',' +
                             cell + '<=' + CONFIG.maxScore + ',' + cell + '=INT(' + cell + '))')
    .setAllowInvalid(false)
    .setHelpText('Whole numbers ' + CONFIG.minScore + '-' + CONFIG.maxScore + ' only — no half points.')
    .build();
}

function buildFormatRules_(scoreRanges, rankRanges) {
  var rules = [];
  if (scoreRanges.length) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue('#f4c7c3', SpreadsheetApp.InterpolationType.NUMBER, String(CONFIG.minScore))
      .setGradientMidpointWithValue('#fff2cc', SpreadsheetApp.InterpolationType.NUMBER,
                                    String((CONFIG.minScore + CONFIG.maxScore) / 2))
      .setGradientMaxpointWithValue('#b7e1cd', SpreadsheetApp.InterpolationType.NUMBER, String(CONFIG.maxScore))
      .setRanges(scoreRanges)
      .build());
  }
  if (rankRanges.length) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberEqualTo(1)
      .setBackground('#fff2cc').setBold(true)
      .setRanges(rankRanges)
      .build());
  }
  return rules;
}

function resetSheet_(sheet) {
  var range = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
  range.breakApart();
  range.clearDataValidations();
  range.clearNote();
  range.clear();
  sheet.clearConditionalFormatRules();
  sheet.setFrozenRows(0);
  sheet.setFrozenColumns(0);
}

function ensureSize_(sheet, cols, rows) {
  if (cols && sheet.getMaxColumns() < cols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
  }
  if (rows && sheet.getMaxRows() < rows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  }
}

function targetSheet_() {
  var ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(CONFIG.targetSheet) || ss.insertSheet(CONFIG.targetSheet);
}

/* -------------------------------------------------------------- helpers -- */

/** Fisher-Yates, in place, returns the same array. */
function shuffle_(list) {
  for (var i = list.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
  }
  return list;
}

function sortTracks_(names) {
  return names.slice().sort(function (a, b) {
    if (a === CONFIG.unassignedLabel) { return 1; }
    if (b === CONFIG.unassignedLabel) { return -1; }
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function trackColor_(track) {
  var match = matchTrackKey_(track);
  return match ? CONFIG.trackColors[match] : CONFIG.defaultTrackColor;
}

function rubricLetter_(track) {
  var match = matchTrackKey_(track, CONFIG.trackRubricLetter);
  return match ? CONFIG.trackRubricLetter[match] : '';
}

function matchTrackKey_(track, map) {
  var source = map || CONFIG.trackColors;
  var keys = Object.keys(source);
  for (var i = 0; i < keys.length; i++) {
    if (String(track).toLowerCase().indexOf(keys[i].toLowerCase()) === 0) { return keys[i]; }
  }
  return '';
}

/** "Track 1 : "The Engine" RAG Architecture..." -> "Track 1" for short messages. */
function shortTrack_(track) {
  var m = String(track).match(/^Track\s*\d+/i);
  return m ? m[0] : String(track).substring(0, 24);
}

/** Team Members cell -> one tidy line of names. */
function formatMembers_(raw) {
  var text = String(raw || '');
  if (CONFIG.stripEmails) {
    text = text.replace(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g, '');
  }
  return text.split(/[\n\r;]+/)
    .map(function (part) {
      return part.replace(/\s+/g, ' ').replace(/^[\s,:;·-]+|[\s,:;·-]+$/g, '').trim();
    })
    .filter(function (part) { return part.length; })
    .join(', ');
}

function key_(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

function unique_(list) {
  var seen = {}, out = [];
  list.forEach(function (v) { if (!seen[v]) { seen[v] = true; out.push(v); } });
  return out;
}

function a1_(col, row) {
  return colLetter_(col) + row;
}

function colLetter_(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

function ui_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; }
}

function notify_(message) {
  Logger.log(message);
  var ui = ui_();
  if (ui) { ui.alert(message); return; }
  try { SpreadsheetApp.getActive().toast(message, 'Judging', 8); } catch (e) { /* headless */ }
}
