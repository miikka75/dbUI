# Kanban / Board View — Implementation Plan

> **Status: implemented** on `claude/dbui-view-expansion-021bo9`. `board.js` + `board-view` +
> wiring + validation are in; unit (`dev/test/board.test.js`) and E2E (`dev/test-ui/board.spec.js`)
> suites pass. **One deviation from the draft below:** a board over a **mirror-detail** table (whose
> columns `syncFrom` a master, like the demo/church `tasks`→`notes`) is **read-only** — the
> `hasMaster` gate that hides the data view's add button also disables board drag/add, because such
> rows mutate only via their master. So the board must target a **standalone** table (exactly the
> real `tehtävät` shape). The demo/fixture therefore ship a standalone `tickets` table + status
> board rather than boarding the mirror `tasks`. Everything else matches this plan.

Add a **seventh view kind**, `board` (kanban), to dbUI. A board groups a single table's rows
into vertical **lanes** by one categorical column; dragging a card between lanes writes that
column back to the row. The flagship use case is the Tampere 1st ward's **`tehtävät`
(callings)** view grouped by **`tila`** — a real 14-stage calling lifecycle that a flat table
hides but a board makes legible.

This document is written to be self-contained: a fresh session with the repo + local server
can implement it end-to-end from here. All file/line references are against the state of the
`claude/dbui-view-expansion-021bo9` branch at the time of writing — re-grep if they have
drifted.

---

## 0. Why this fits with almost no new plumbing

A board view is **a data view plus a `lane` grouping column**. It carries the same
`sources`/`columns`/`filter` as a data view, so:

- **Data loading is free.** `loadTableData()` (`app-core.js:1205`) routes any view that has
  `sources` (and none of the `calendar`/`rotation`/`pivot`/`rsvp` discriminator fields) through
  the "Union or join view" path (`app-core.js:1248`), which sets `self.currentData = rows` with
  filters, `compute`, and embeds already applied. A board just needs `selectTab` to *call*
  `loadTableData` for it.
- **Writes are free.** Dragging a card calls the existing `saveField(item, laneCol, newLane)`
  (`app-core.js:1345`), which updates `currentData`, patches `dataCache`, stamps `updated_at`,
  and debounce-persists through whatever backend is active. No new write path.
- **Rendering follows the established registry pattern.** Every kind is (1) a discriminator
  field, (2) a pure Node-tested builder module, (3) a component registered in
  `window.VIEW_KINDS`. We add one of each.

So the bulk of the work is: a pure `board.js` grouping builder, a `board-view` Vue component
with drag-and-drop, and ~6 small wiring edits.

---

## 1. Schema shape

A board view is discriminated by a top-level **`board`** object. Minimal:

```json
{
  "name": "tehtävät",
  "sources": ["tehtävät"],
  "board": { "lane": "tila" },
  "columns": ["henkilö", "organisaatio", "tehtävä", "vastuussa", "huomioitavaa"],
  "mode": "join",
  "defaultSort": "pvm"
}
```

`board` config fields (all optional except `lane`):

| Field | Meaning |
|-------|---------|
| `lane` | **(required)** column whose distinct values become lanes. Must be a `select` column on the (single) source table. Dragging a card sets this column. |
| `lanes` | Explicit ordered list of lane keys. Omit → order comes from the column's list (authored order), else distinct values in the data. Keys listed here render even when empty (so a "kutsutaan" lane shows up before any card is there). |
| `hiddenLanes` | Lane keys to omit from the board (e.g. terminal `Vapautettu`, `Kieltäytynyt`). Cards in a hidden lane simply don't render; use with `laneGroups` collapse instead if you want them reachable. |
| `laneGroups` | Ordered `[{ label, lanes:[...], collapsed? }]` — renders lanes under collapsible **phase** headers. This is how we tame 14 lanes (see §7). A lane not named in any group falls into an implicit trailing group. |
| `title` | Card-face column used as the card heading (default: the first entry of `columns`). |
| `columns` | (top-level view field, reused) the columns shown on each card face, in order, minus `lane`/`title`. |
| `color` | Optional column whose value tints the card's left border via `hashColor` (nice for `organisaatio` or `vastuussa`). |
| `addInLane` | `true` to show a "+ add" affordance per lane that creates a row pre-stamped with that lane value (see §6, optional). |

`lane` is the only field the builder strictly needs; everything else is presentation.

---

## 2. New pure builder — `board.js` (repo root)

Mirror `pivot.js` / `rsvp.js`: framework-agnostic, Node-testable, exposes `Board.build`. It is
a thin one-dimensional group-by with stable ordering and empty-lane materialization.

Create **`/board.js`**:

```js
// board.js — Pure kanban/board builder: bucket a flat row list into lanes by one column's value.
// The one-dimensional, WRITABLE cousin of pivot.js (pivot aggregates to numbers and is read-only;
// a board keeps whole rows so cards stay editable and draggable). Framework-agnostic + Node-tested,
// mirroring pivot.js / rsvp.js / rotation.js.
//   Browser: <script src="/board.js">, then Board.build(rows, opts). Node: const Board = require('../board').
//
// opts:
//   lane        column name whose value places a row in a lane (required)
//   laneOrder   explicit ordered lane keys; keys not present in the data still render as EMPTY lanes.
//               Omit -> derive from the data in first-seen order.
//   hidden      lane keys to drop entirely (array)
//   sortWithin  optional comparator(a,b) applied to each lane's rows (default: keep input order,
//               which is already the view's defaultSort order from currentData)
//
// A row whose lane value is blank/'' goes into the '' (unassigned) lane key — surface or hide it
// via laneOrder/hidden as the view prefers. Array-valued lane columns are NOT expanded (a board card
// belongs to exactly one lane); the first array element (or '') is used.
(function(root) {
  function laneKey(v) { return Array.isArray(v) ? (v.length ? String(v[0]) : '') : (v == null ? '' : String(v)); }

  function build(rows, opts) {
    rows = rows || [];
    var laneCol = opts.lane;
    var hidden = {};
    (opts.hidden || []).forEach(function(k) { hidden[k] = 1; });

    var order = (opts.laneOrder || []).slice();
    var seen = {};
    order.forEach(function(k) { seen[k] = 1; });

    var buckets = {};
    order.forEach(function(k) { buckets[k] = []; });   // materialize declared (possibly empty) lanes

    rows.forEach(function(r) {
      var k = laneKey(r[laneCol]);
      if (hidden[k]) return;
      if (!(k in seen)) { seen[k] = 1; order.push(k); }
      (buckets[k] || (buckets[k] = [])).push(r);
    });

    var lanes = order.filter(function(k) { return !hidden[k]; }).map(function(k) {
      var items = buckets[k] || [];
      if (opts.sortWithin) items = items.slice().sort(opts.sortWithin);
      return { key: k, count: items.length, items: items };
    });

    return { lanes: lanes };
  }

  var M = { build: build };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Board = M;
})(typeof self !== 'undefined' ? self : this);
```

Load it in the browser next to the other view builders. Find where `pivot.js` is included
(grep `pivot.js` in `index.html` and `apps-script/index.html`) and add a sibling
`<script src="/board.js"></script>` line in the **same places** — the offline/E2E harness and
`apps-script` bundle both need it. (`board.js` has no dependencies, unlike `rotation.js` which
must load after `calendar.js`.)

---

## 3. Node tests — `dev/test/board.test.js`

Mirror `dev/test/pivot.test.js`. Run with `cd dev && npm test`.

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Board = require('../../board');

describe('board.js — lane bucketing', () => {
  const rows = [
    { id: '1', tila: 'kutsutaan', henkilö: 'Ann' },
    { id: '2', tila: 'vastaanotettu', henkilö: 'Bob' },
    { id: '3', tila: 'kutsutaan', henkilö: 'Cec' },
    { id: '4', tila: '', henkilö: 'Dan' }
  ];

  it('groups rows into lanes, first-seen order', () => {
    const b = Board.build(rows, { lane: 'tila' });
    assert.deepEqual(b.lanes.map(l => l.key), ['kutsutaan', 'vastaanotettu', '']);
    assert.deepEqual(b.lanes[0].items.map(r => r.id), ['1', '3']);
    assert.equal(b.lanes[0].count, 2);
  });

  it('laneOrder materializes empty lanes and fixes order', () => {
    const b = Board.build(rows, { lane: 'tila', laneOrder: ['kutsutaan', 'vastaanotettu', 'kiitetään'] });
    assert.deepEqual(b.lanes.map(l => l.key), ['kutsutaan', 'vastaanotettu', 'kiitetään', '']);
    assert.equal(b.lanes[2].count, 0);          // kiitetään declared but empty -> still present
  });

  it('hidden drops lanes; blank lane hideable', () => {
    const b = Board.build(rows, { lane: 'tila', hidden: [''] });
    assert.deepEqual(b.lanes.map(l => l.key), ['kutsutaan', 'vastaanotettu']);
  });

  it('sortWithin orders cards inside a lane', () => {
    const b = Board.build(rows, { lane: 'tila', sortWithin: (a, c) => a.henkilö.localeCompare(c.henkilö) });
    assert.deepEqual(b.lanes[0].items.map(r => r.henkilö), ['Ann', 'Cec']);
  });
});
```

---

## 4. `app-core.js` wiring (six edits)

### 4.1 `isBoardView` computed — near the other `isXView` computeds (`app-core.js:234-237`)

```js
isBoardView: function() { var v = VIEWS[this.currentTable]; return !!(v && v.board); },
```

### 4.2 Exclude board from `isDataView` (`app-core.js:232`)

A board carries `sources`, so without this it would double-classify as a data view. Add
`|| v.board` to the exclusion list:

```js
isDataView: function() {
  var v = VIEWS[this.currentTable];
  return this.currentTable && this.currentTable[0] !== '_' &&
    !(v && (typeof v.markdown === 'string' || v.rotation || v.calendar || v.pivot || v.rsvp || v.board)) &&
    (v || SCHEMA[this.currentTable]);
},
```

### 4.3 `viewKind` dispatch (`app-core.js:248-259`)

Add a branch **before** `isDataView` (order matters — board must win over data):

```js
if (this.isRsvpView) return 'rsvp';
if (this.isBoardView) return 'board';     // <-- add
if (this.currentPage) return 'page';
if (this.isDataView) return 'data';
```

### 4.4 Register the component (`app-core.js:3252`)

```js
window.VIEW_KINDS = {
  calendar: 'calendar-view', rotation: 'rotation-view', pivot: 'pivot-view', rsvp: 'rsvp-view',
  board: 'board-view',                    // <-- add
  page: 'page-view', data: 'data-view',
  languages: 'languages-view', lookup: 'lookup-view', settings: 'settings-view'
};
```

### 4.5 Load data on tab switch (`app-core.js:919-920`)

`loadTableData` already handles a board (it falls through to the sources path), we just need to
call it. Add `isBoardView` to the data-loading branch:

```js
if (this.isCalendarView || this.isPivotView || this.isRsvpView) { this.loadTableData(); }
else if (this.isDataView || this.isRotationView || this.isBoardView) { this.periodOffset = 0; this.loadTableData(); }
```

### 4.6 i18n key generation (`app-core.js:580-584`)

So lane column headers and card fields get `field.*` translation keys. Add a `board` block
alongside the `pivot` one:

```js
if (v.board && v.board.lane) keys.push('field.' + v.board.lane);   // <-- add near the v.pivot block
```

(The card-face `columns` already get keys via the existing `(v.columns||[]).forEach` loop at
`app-core.js:585`.)

---

## 5. The `board-view` component (`app-core.js`, near the other kind components ~3448+)

Reads `appInstance.currentData` (already lane-filtered/computed by `loadTableData`), groups it
with `Board.build`, renders lanes of draggable cards, and writes the lane column on drop via
`saveField`. Uses **native HTML5 drag-and-drop** — no external DnD library (CSP forbids external
scripts; there is no build step). Provides a **mobile fallback** (touch DnD is unreliable): each
card gets a "move" dropdown of lane options.

```js
// Board (kanban) view — single-source data view rendered as lanes grouped by `board.lane`.
// Reads the root's currentData (same editable rows the data grid uses) so a drag writes straight
// back through saveField. name/embed parameterized like the other kind components.
app.component('board-view', {
  props: { name: { type: String, default: null }, embed: { type: Boolean, default: false } },
  data: function() { return { dragId: null, overLane: null }; },
  computed: {
    a: function() { return appInstance; },
    viewName: function() { return this.name || appInstance.currentTable; },
    cfg: function() { return (VIEWS[this.viewName] && VIEWS[this.viewName].board) || {}; },
    laneCol: function() { return this.cfg.lane; },
    canEdit: function() { return appInstance.canMutateRows; },
    // Lane keys in the intended order: explicit `lanes`, else the lane column's list (authored order).
    laneOrder: function() {
      if (this.cfg.lanes) return this.cfg.lanes.slice();
      return (appInstance.getListOptions(this.laneCol) || []).map(function(o) { return o.value; });
    },
    board: function() {
      return Board.build(appInstance.currentData || [], {
        lane: this.laneCol, laneOrder: this.laneOrder, hidden: this.cfg.hiddenLanes || []
      });
    },
    // Phase grouping (§7). Returns [{ label, collapsed, lanes:[laneObj,...] }]. When no laneGroups
    // config, one implicit group holding every lane.
    groups: function() {
      var laneMap = {}; this.board.lanes.forEach(function(l) { laneMap[l.key] = l; });
      var cfgGroups = this.cfg.laneGroups;
      if (!cfgGroups || !cfgGroups.length) return [{ label: null, collapsed: false, lanes: this.board.lanes }];
      var used = {}, out = cfgGroups.map(function(g) {
        var lanes = (g.lanes || []).map(function(k) { used[k] = 1; return laneMap[k]; }).filter(Boolean);
        return { label: g.label, collapsed: !!g.collapsed, lanes: lanes };
      });
      var rest = this.board.lanes.filter(function(l) { return !used[l.key]; });
      if (rest.length) out.push({ label: null, collapsed: false, lanes: rest });
      return out;
    }
  },
  methods: Object.assign({}, ROOT_PROXY, {
    laneLabel: function(k) { return k === '' ? appInstance.tOr('board.unassigned', '—') : appInstance.displayValue(this.laneCol, k); },
    cardTitle: function(item) { var c = this.cfg.title || (VIEWS[this.viewName].columns || [])[0]; return c ? appInstance.displayValue(colName(c), item[colName(c)]) : (item.id || ''); },
    cardCols: function() {
      var self = this, title = this.cfg.title || (VIEWS[this.viewName].columns || [])[0];
      return (VIEWS[this.viewName].columns || []).map(colName)
        .filter(function(c) { return c !== colName(title) && c !== self.laneCol && typeof c === 'string'; });
    },
    cardColor: function(item) { return this.cfg.color ? Calendar.hashColor(item[this.cfg.color]) : null; },
    // --- drag/drop (desktop) ---
    onDragStart: function(item) { if (this.canEdit) this.dragId = item.id; },
    onDragEnd: function() { this.dragId = null; this.overLane = null; },
    onDrop: function(laneKey) {
      if (!this.canEdit || !this.dragId) return;
      var item = (appInstance.currentData || []).find(function(r) { return r.id === this.dragId; }, this);
      if (item && String(item[this.laneCol] || '') !== laneKey) appInstance.saveField(item, this.laneCol, laneKey, this.viewName);
      this.onDragEnd();
    },
    // --- mobile / a11y fallback: move via menu ---
    moveTo: function(item, laneKey) { if (this.canEdit) appInstance.saveField(item, this.laneCol, laneKey, this.viewName); },
    laneMenuItems: function() { var self = this; return this.laneOrder.map(function(k) { return { value: k, title: self.laneLabel(k) }; }); }
  }),
  template: ''
    + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'\'" data-testid="board-view">'
    + '<div v-for="(g, gi) in groups" :key="gi">'
    + '  <div v-if="g.label" class="px-3 pt-2" style="font-size:0.72rem;font-weight:700;text-transform:uppercase;opacity:0.6">{{ g.label }}</div>'
    + '  <div class="board-lanes" style="display:flex;gap:10px;overflow-x:auto;padding:8px;align-items:flex-start">'
    + '    <div v-for="lane in g.lanes" :key="lane.key" class="board-lane"'
    + '         style="flex:0 0 240px;min-width:240px;background:rgb(var(--v-theme-on-surface),0.04);border-radius:8px;padding:6px"'
    + '         :style="overLane===lane.key ? \'outline:2px dashed rgb(var(--v-theme-primary))\' : \'\'"'
    + '         @dragover.prevent="overLane=lane.key" @dragleave="overLane=null" @drop="onDrop(lane.key)" :data-testid="\'board-lane-\'+lane.key">'
    + '      <div style="display:flex;align-items:center;gap:6px;font-weight:600;font-size:0.85rem;padding:2px 4px 6px">'
    + '        <span>{{ laneLabel(lane.key) }}</span>'
    + '        <span style="opacity:0.5;font-weight:400">{{ lane.count }}</span></div>'
    + '      <div v-for="item in lane.items" :key="item.id" class="board-card"'
    + '           :draggable="canEdit ? \'true\' : \'false\'" @dragstart="onDragStart(item)" @dragend="onDragEnd"'
    + '           :style="\'background:rgb(var(--v-theme-surface));border:1px solid rgb(var(--v-theme-outline),0.15);border-radius:6px;padding:6px 8px;margin-bottom:6px;cursor:\'+(canEdit?\'grab\':\'default\')+(cardColor(item)?\';border-left:3px solid \'+cardColor(item):\'\')"'
    + '           :data-testid="\'board-card-\'+item.id">'
    + '        <div style="display:flex;align-items:flex-start;gap:4px">'
    + '          <div style="font-weight:600;font-size:0.85rem;flex:1">{{ cardTitle(item) }}</div>'
    + '          <v-menu v-if="canEdit"><template v-slot:activator="{ props }">'
    + '            <v-btn v-bind="props" icon="mdi-dots-vertical" size="x-small" variant="text" density="comfortable" :data-testid="\'board-move-\'+item.id"></v-btn></template>'
    + '            <v-list density="compact"><v-list-subheader>{{ tOr(\'board.move_to\',\'Move to\') }}</v-list-subheader>'
    + '            <v-list-item v-for="opt in laneMenuItems()" :key="opt.value" @click="moveTo(item, opt.value)">'
    + '              <v-list-item-title>{{ opt.title }}</v-list-item-title></v-list-item></v-list></v-menu>'
    + '        </div>'
    + '        <div v-for="col in cardCols()" :key="col" style="font-size:0.78rem;opacity:0.85"><span style="opacity:0.6">{{ t(\'field.\'+col) || col }}: </span>{{ displayValue(col, item[col]) }}</div>'
    + '      </div>'
    + '      <div v-if="!lane.items.length" style="opacity:0.4;font-size:0.78rem;padding:4px">—</div>'
    + '    </div>'
    + '  </div>'
    + '</div>'
    + '</component>'
});
```

Notes:
- `ROOT_PROXY` supplies `t`, `tOr`, `displayValue`, `toDateStr`, etc. (same proxy the other kind
  components use). `colName`, `Calendar`, `VIEWS`, `Board` are module-scope globals already in
  `app-core.js`.
- The move-menu doubles as the **mobile/touch and keyboard-accessible** path, so the feature is
  usable without HTML5 drag (which doesn't fire on touch). Desktop users get both.
- Cards are read-through-only here (title + fields). Full inline card editing is out of scope for
  v1 — clicking through to the data view remains the edit path if needed. (Optional enhancement:
  make the card title open the row in an edit dialog; reuse the data view's edit affordances.)

---

## 6. Optional — add a row into a lane (`board.addInLane`)

Mirrors `calendarAddOnDay` (`app-core.js:955`). Add a root method and a per-lane "+" button
gated on `cfg.addInLane && canEdit`:

```js
boardAddInLane: function(name, laneKey) {
  var v = VIEWS[name]; if (!v || !v.board) return;
  var table = v.sources[0];
  var prefill = {}; prefill[v.board.lane] = laneKey;
  this._createBlankRow(table, { prefill: prefill });
  this.notify('Row added');
}
```

Skip for v1 if you want the smallest surface; the move-menu already covers reassigning existing
rows.

---

## 7. Taming 14 lanes — `laneGroups` (the `tehtävät` case)

`tehtävät.tila` has 14 values. Rendered as 14 raw lanes the board scrolls a lot horizontally.
The `laneGroups` config renders them under collapsible **phase** headers, matching the calling
lifecycle. The component's `groups` computed already implements the grouping; the schema drives
it. Recommended grouping for the ward board:

```json
"board": {
  "lane": "tila",
  "laneGroups": [
    { "label": "Harkinta",   "lanes": ["Keskustellaan", "Rukoillaan", "Hyväksytty piispakunnassa"] },
    { "label": "Kutsu",      "lanes": ["kutsutaan", "vastaanotettu", "Hyväksytty seurakunnassa", "Hyväksyminen kirjattu"] },
    { "label": "Erottaminen","lanes": ["Erotettu tehtävään", "Erotus tehtävään kirjattu"] },
    { "label": "Vapautus",   "lanes": ["Tarvitsee vapauttaa", "kiitetään", "Vapautettu", "Vapautus kirjattu"], "collapsed": true }
  ],
  "hiddenLanes": ["Kieltäytynyt"]
}
```

`collapsed` groups render a foldable header (implement the fold with a small `data`-level
`collapsedGroups` set toggled by clicking the label — a few lines on top of the `groups`
computed). `Kieltäytynyt` (declined) is hidden as a terminal off-ramp; drop it from `hiddenLanes`
if you prefer it visible.

**Integration bonus (no code):** moving a card into `vastaanotettu` or `kiitetään` writes
`tila`, which the existing `ohjelma` and `piispakunta` views already filter on
(`{"tila":"vastaanotettu"}` / `{"tila":"kiitetään"}` / `{"tila":"kutsutaan"}`). So the board
feeds next Sunday's sacrament-meeting program automatically — the whole point of choosing
`tehtävät` as the flagship.

---

## 8. `schema-loader.js` validation

### 8.1 Flatten (`schema-loader.js:10`)

Board views have `sources`, so `_flattenViews` already registers them. Add `|| v.board`
defensively so the intent is explicit and a future sourceless board still flattens:

```js
function _flattenViews(arr) { (arr || []).forEach(function(v) { if (v.name && (v.sources || typeof v.markdown === 'string' || v.rotation || v.calendar || v.pivot || v.rsvp || v.board)) VIEWS[v.name] = v; if (v.views) _flattenViews(v.views); }); }
```

### 8.2 `validateSchema` — add a board block (after the `rsvp` block, ~`schema-loader.js:202`)

```js
// Board (kanban) view: single writable source + a select lane column.
if (view.board) {
  var bd = view.board;
  if (!bd.lane) errors.push('board "' + v + '" needs a `lane` column');
  if (!view.sources || view.sources.length !== 1)
    errors.push('board "' + v + '" needs exactly one source table (drag writes go to one table)');
  else {
    var bt = view.sources[0], bcols = (SCHEMA[bt] && SCHEMA[bt].columns) || {};
    var ld = bcols[bd.lane], lt = (typeof ld === 'string') ? ld : (ld && ld.type);
    if (bd.lane && !ld) errors.push('board "' + v + '" lane "' + bd.lane + '" not found in "' + bt + '"');
    else if (bd.lane && lt !== 'select') errors.push('board "' + v + '" lane "' + bd.lane + '" in "' + bt + '" must be a select column');
    (bd.laneGroups || []).forEach(function(g) { if (!g || !Array.isArray(g.lanes)) errors.push('board "' + v + '" laneGroups entries need a `lanes` array'); });
  }
}
```

(`validateRefs` at `schema-loader.js:233` already covers `sources` → missing table, so nothing
to add there.)

---

## 9. i18n

Add UI strings used by the component to the English base translations (wherever the other
`pivot.*` / `rsvp.*` / `cal.*` keys are seeded — grep `pivot.total` / `pivot.empty` to find the
base map, likely `dev/schema.json` translations or a defaults block in `app-core.js`):

```
board.move_to     = "Move to"
board.unassigned  = "—"
```

Lane header labels and card field labels reuse existing `field.*` and `list.<listName>.*` keys
via `displayValue`, so `tila`'s Finnish values already translate if their `list.tilat.*` keys
exist (they will, since the table already renders `tila`).

---

## 10. Docs

- **`dev/SCHEMA.md`** — add a "## board (seventh view kind)" section modeled on the pivot/rsvp
  sections (`grep -n '## pivot' dev/SCHEMA.md`), documenting the config in §1 and the
  `tehtävät`/`laneGroups` example. Update the intro line that enumerates the six kinds (README
  line ~11 and SCHEMA.md's "which field it carries" note) to include `board`.
- **`README.md`** — extend the Views bullet (line ~11) to mention the board/kanban kind.

---

## 11. E2E (optional but recommended) — `dev/test-ui/`

Add a Playwright spec (mirror an existing one in `dev/test-ui/`) that:
1. Seeds a `tehtävät`-like table + a board view via the existing test schema-injection helper
   (see how `app.spec.js` injects `window.VIEWS`/schema around lines 900-925).
2. Asserts lanes render (`[data-testid^="board-lane-"]`) and a card shows in the right lane.
3. Uses the **move menu** (`board-move-<id>` → lane item) rather than synthetic drag (HTML5 DnD
   is painful to drive headlessly) to move a card and asserts the row's `tila` changed and the
   card re-homed to the new lane.

Run offline suites from `dev/`: `npm test` (unit incl. `board.test.js`) and
`npm run test:ui` (Playwright). The board needs no network, so both run in the web container.

---

## 12. Local test drive (church schema)

The uploaded export is **schema-only** (no rows/lists in the file the app imports as data). To
see a populated board locally:

```bash
cd dev
npm start                      # http://127.0.0.1:3000
```

1. Browser → "Create Local Database".
2. Settings → **Import from JSON** → paste the full church bundle (schema **and** the `lists`
   block you shared, plus any row data export). The `tilat` list must be present so lanes get
   their authored order + Finnish labels.
3. Add the board view to the schema (Settings → schema editor, or edit the imported JSON) — the
   simplest is to **add a second view** so the existing table `tehtävät` view stays intact:

```json
{
  "name": "tehtävätaulu",
  "sources": ["tehtävät"],
  "mode": "join",
  "defaultSort": "pvm",
  "board": {
    "lane": "tila",
    "laneGroups": [
      { "label": "Harkinta",    "lanes": ["Keskustellaan","Rukoillaan","Hyväksytty piispakunnassa"] },
      { "label": "Kutsu",       "lanes": ["kutsutaan","vastaanotettu","Hyväksytty seurakunnassa","Hyväksyminen kirjattu"] },
      { "label": "Erottaminen", "lanes": ["Erotettu tehtävään","Erotus tehtävään kirjattu"] },
      { "label": "Vapautus",    "lanes": ["Tarvitsee vapauttaa","kiitetään","Vapautettu","Vapautus kirjattu"], "collapsed": true }
    ],
    "hiddenLanes": ["Kieltäytynyt"]
  },
  "columns": ["henkilö","organisaatio","tehtävä","vastuussa","huomioitavaa"],
  "color": "organisaatio"
}
```

   Add it to `nav.items` (e.g. under the existing `tehtävät` entry) so it appears in the sidebar.
4. Open the board, drag a calling from `kutsutaan` → `vastaanotettu`, confirm the row's `tila`
   updates (check the plain `tehtävät` table view) and — if `ohjelma` has a matching-date meeting
   — that it now surfaces under the sustain list.

`tehtävät` has no `syncFrom`/mirror columns, so board writes are a plain single-table update with
no cascade concerns.

---

## 13. Implementation checklist

- [ ] `/board.js` pure builder
- [ ] `dev/test/board.test.js` (green under `npm test`)
- [ ] `<script src="/board.js">` added in `index.html` **and** `apps-script/index.html` (next to `pivot.js`)
- [ ] `isBoardView` computed
- [ ] `board` added to `isDataView` exclusion
- [ ] `viewKind` board branch (before `data`)
- [ ] `VIEW_KINDS.board = 'board-view'`
- [ ] `selectTab` load branch includes `isBoardView`
- [ ] i18n key-gen `field.<lane>` for boards
- [ ] `board-view` component (with move-menu fallback)
- [ ] `schema-loader.js` `_flattenViews` + `validateSchema` board block
- [ ] `board.move_to` / `board.unassigned` translations
- [ ] `dev/SCHEMA.md` + `README.md` board sections
- [ ] (optional) `board.addInLane`
- [ ] (optional) Playwright spec
- [ ] Local drive against `tehtävät` with the church bundle

## 14. Scope boundaries (v1)

- **One lane column, one source table.** Multi-source boards are out (drag-write target must be
  unambiguous — same reason a union data view isn't a good board).
- **Read-only cards** (title + fields) with drag/menu to change the lane column only. Full inline
  card editing is a follow-up.
- **No reordering within a lane persisted.** Card order within a lane follows the view's
  `defaultSort`. (Persisted manual ordering would need a per-row rank column — a separate feature,
  akin to the `reorderable`/`position` pattern the roster tables use.)
- Boards are **not embeddable** via `{{view:}}` in v1 (the component supports an `embed` prop for
  symmetry, but wire up the embed path only if needed — `loadTableData` populates `currentData`
  for the *current* view, so an embedded board on a different view would need its own row fetch
  like `rotationRowsFor`).
