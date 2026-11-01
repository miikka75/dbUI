# dbUI features

Every feature of the app, with a page each: what it does, the schema that turns it on, screenshots and which backends support it. The full schema vocabulary is in [SCHEMA.md](../SCHEMA.md).

**Backends:** *In this browser* = PostgreSQL in WebAssembly, stored in the browser · *Supabase* = hosted Postgres + RLS · *Firebase* = Firestore + rules · *Dev server* = local Node server running the Supabase policies (`cd dev && npm start`). See [Backends & setup](features/backends.md).

✅ supported · ⚠️ partly (see note) · ❌ not supported · — not applicable

| Area | Feature | What it does | In this browser | Supabase | Firebase | Dev server |
|---|---|---|---|---|---|---|
| Views | [Data views (table, cards, gallery)](features/data-views.md) | Rows of one or more tables as an editable grid, cards or a picture gallery; union or join of sources. | ✅ | ✅ | ✅ | ✅ |
| Views | [Aggregates & leaderboards](features/aggregate.md) | Group rows and count/sum/max/min them — a points leaderboard per person per month. | ✅ | ✅ | ✅ | ✅ |
| Views | [Pages & embeds (documents)](features/documents.md) | Markdown pages that embed live, editable views and tables; admins edit them in the app. | ✅ | ✅ | ✅ | ✅ |
| Views | [Calendar](features/calendar.md) | Year/month/week/list calendar over dated rows from several tables, with rotation duties, day-add and .ics export. | ✅ | ✅ | ✅ | ✅ |
| Views | [Calendar feeds (subscribe)](features/calendar-feeds.md) | Publish a calendar as a subscribable .ics URL — shared, or one private feed per person. | ❌ no file storage | ✅ | ⚠️ needs Storage (Blaze plan) | ✅ |
| Views | [Rotating rosters](features/rotation.md) | Duty rotas generated from rosters: a weekly crew rota, a person × task matrix, per-person views. | ✅ | ✅ | ✅ | ✅ |
| Views | [Pivot (cross-tab)](features/pivot.md) | Count or sum rows by two columns at once, with totals — who did which chore how often. | ✅ | ✅ | ✅ | ✅ |
| Views | [RSVP & bookings](features/rsvp.md) | Self-service sign-up sheet: members book events, with capacity, booking windows, no-show release and check-in. | ✅ | ✅ | ✅ | ✅ |
| Views | [RSVP waitlist](features/rsvp.md#rsvp-waitlist) | A full event takes a queue; a cancellation books the longest-waiting member automatically. | ✅ | ✅ | ❌ rules cannot promote; not offered | ✅ |
| Views | [Board (kanban)](features/board.md) | Cards in lanes by a select column; drag a card to another lane to change it, order cards by hand, compact cards that open, lanes that fold. | ✅ | ✅ | ✅ | ✅ |
| Views | [Form](features/form.md) | A one-record form with required fields and rules — buy a membership, request a pause. | ✅ | ✅ | ✅ | ✅ |
| Views | [Stats (KPI tiles)](features/stats.md) | Number tiles, progress bars, goals, streaks, a tile per period and tiered badges over the aggregate pipeline. | ✅ | ✅ | ✅ | ✅ |
| Views | [Timeline (gantt)](features/timeline.md) | Rows as bars across weeks or months between a start and an end date. | ✅ | ✅ | ✅ | ✅ |
| Views | [Scan (barcode / QR)](features/scan.md) | Scanning or typing a code appends a row — a chore done, a gym visit — with printable labels and phone-camera links. | ✅ | ✅ | ✅ | ✅ |
| Views | [Search & reader filters](features/search-filters.md) | A search box over chosen columns, and drop-down filters a reader narrows a page or calendar by. | ✅ | ✅ | ✅ | ✅ |
| Data | [Tables & column types](features/columns.md) | Tables declared in JSON with text, number, date, datetime, select, ref, url, image and owner columns. | ✅ | ✅ | ✅ | ✅ |
| Data | [Computed & conditional columns](features/computed-columns.md) | Values derived at render time: lookups, counts, date arithmetic, streaks, and columns shown only when a condition holds. | ✅ | ✅ | ✅ | ✅ |
| Data | [Lists & lookup tables](features/lists.md) | Drop-down values edited in the app (Lists tab), lookup tables with hierarchy, translatable values. | ✅ | ✅ | ✅ | ✅ |
| Data | [Images & links](features/images.md) | Image columns with in-browser upload (resized, metadata stripped) and URL columns. | ⚠️ stored in the database | ✅ | ⚠️ Storage needs Blaze; else in the database | ✅ |
| Data | [Archive, auto-archive & copy forward](features/archive.md) | Move finished rows to a Past tab, by hand or automatically after a delay; copy a range of dated rows forward. | ✅ | ✅ | ✅ | ✅ |
| Data | [Undo & redo](features/undo.md) | Undo and redo the edits you made in this session from the app bar. | ✅ | ✅ | ✅ | ✅ |
| Data | [Import, export & examples](features/import-export.md) | Export the whole database as JSON, import a bundle, or start from a shipped example. | ✅ | ✅ | ✅ | ✅ |
| Access | [Users, roles & table grants](features/users-access.md) | Admin / editor / viewer roles with per-table read or read-write grants, edited in Settings → Users. | ✅ identity is self-asserted (rehearsal) | ✅ | ✅ | ✅ not enforced with `--sqlite` |
| Access | [Self-service rows (owner)](features/self-service.md) | Members write only their own rows — log a chore, book a class — without a grant on the table. | ✅ | ✅ | ✅ | ✅ |
| Access | [Public tables (visitors)](features/public-tables.md) | Tables anyone can read without an account — a timetable, a price list — with a Sign in button. | ✅ | ✅ | ✅ | ✅ |
| Access | [Membership requests & open sign-up](features/membership.md) | A new account requests access with its name, or joins on its own with a fixed grant. | ✅ | ✅ | ✅ | ✅ |
| Access | [Profiles & user-linked lists](features/profiles.md) | Display name and avatar per user; list values linked to accounts so `@me` and per-person views work. | ✅ | ✅ | ✅ | ✅ |
| Look & navigation | [Navigation](features/navigation.md) | Side drawer, top tabs or browse pages (list or tiles), nested groups, role-based items and a phone bottom bar. | ✅ | ✅ | ✅ | ✅ |
| Look & navigation | [Theme & appearance](features/theme.md) | Brand palette for light and dark mode, edited live; background images and menu tiles per screen. | ✅ | ✅ | ✅ | ✅ |
| Look & navigation | [Languages & translations](features/i18n.md) | Every label is a translation key; the Languages tab edits them per language. | ✅ | ✅ | ✅ | ✅ |
| Look & navigation | [Print](features/print.md) | Print a view as a table or cards, a single card, or a label sheet; embeds included. | ✅ | ✅ | ✅ | ✅ |
| Look & navigation | [Installable app & icons](features/pwa.md) | Install to a phone home screen or desktop; name, icon and colours follow each database. | ✅ | ✅ | ✅ | ✅ |
| Platform | [Backends & setup](features/backends.md) | Pick a backend on first open: in-browser Postgres, Supabase, Firebase or the local dev server. | ✅ | ✅ | ✅ | ✅ |
| Platform | [Offline use](features/backends.md#offline-use) | Keep working without a connection. | ✅ | ❌ no offline cache | ✅ | — |
| Platform | [Live sync](features/live-sync.md) | Other people's edits appear without a reload. | — one tab, nothing to sync | ✅ | ✅ | ✅ |
| Platform | [Share links & multiple databases](features/sharing.md) | One deployment serves many databases; a link carries the connection so a new user connects in one click. | ❌ data stays in one browser | ✅ | ✅ | — |
| Platform | [Content-Security-Policy & reports](features/csp.md) | A strict CSP on every deploy, with optional violation reports read in Settings. | ✅ | ✅ | ✅ | ✅ |

Screenshots are generated from the shipped examples: `cd dev && npm run docs:screenshots`.
